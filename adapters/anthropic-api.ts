"use strict";

// ai-gateway/adapters/anthropic-api.ts
// Anthropic Messages API via @anthropic-ai/sdk.
//
// Phase 4: supports both prompt-mode (single prompt → text) and chat-mode
// (messages + system + tools + optional streaming). Chat-mode mirrors
// src/app/llm/client.ts:chatAnthropic shape verbatim — that's the legacy
// callsite this adapter replaces.

const { IAIAdapter } = require("./adapter-interface");

const REQUEST_TIMEOUT_MS = 60_000;

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | Array<Record<string, unknown>>;
}

interface ToolSpec {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AdapterCompleteRequest {
  prompt?: string;
  messages?: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolSpec[];
  onDelta?: (text: string) => void;
  model: string;
  maxOutputTokens: number;
  schema?: Record<string, unknown> | null;
}

interface AdapterCompleteResponse {
  text: string | null;
  schemaJson: unknown | null;
  tokensIn: number;
  tokensOut: number;
  needsToolExecution?: boolean;
  response?: Record<string, unknown> | null;
}

let _client: any = null;

function _getClient(): any {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.NEXUS_ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Anthropic = require("@anthropic-ai/sdk");
  _client = new Anthropic.default({ apiKey });
  return _client;
}

class AnthropicAPIAdapter extends IAIAdapter {
  get provider(): string {
    return "anthropic-api";
  }

  async complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse> {
    const client = _getClient();
    const isChatMode = Array.isArray(req.messages);

    // Build messages: prompt-mode wraps single prompt; chat-mode passes through.
    const messages: ChatMessage[] = isChatMode
      ? (req.messages as ChatMessage[])
      : [{ role: "user", content: String(req.prompt || "") }];

    const baseBody: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      messages,
    };
    if (req.systemPrompt) baseBody.system = req.systemPrompt;
    if (req.tools && req.tools.length > 0) baseBody.tools = req.tools;

    // Non-streaming path (both prompt-mode and chat-mode without onDelta).
    if (!req.onDelta) {
      const resp = await client.messages.create(baseBody, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return _shapeNonStreaming(resp, req);
    }

    // Streaming path (chat-mode only).
    const stream = await client.messages.create(
      { ...baseBody, stream: true },
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );

    const content: Array<Record<string, any>> = [];
    let current: any = null;
    const usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: string | null = null;

    for await (const event of stream as any) {
      if (event.type === "message_start") {
        usage.input_tokens = event.message?.usage?.input_tokens || 0;
      } else if (event.type === "content_block_start") {
        const blk: any = { ...event.content_block };
        if (blk.type === "text") blk.text = "";
        else if (blk.type === "tool_use") blk.input = "";
        current = blk;
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta" && current?.type === "text") {
          current.text += event.delta.text;
          try { req.onDelta(event.delta.text); } catch (_e) { /* swallow */ }
        } else if (event.delta.type === "input_json_delta" && current?.type === "tool_use") {
          current.input += event.delta.partial_json || "";
        }
      } else if (event.type === "content_block_stop") {
        if (current?.type === "tool_use") {
          try { current.input = JSON.parse(current.input || "{}"); } catch (_e) { current.input = {}; }
        }
        if (current) content.push(current);
        current = null;
      } else if (event.type === "message_delta") {
        if (event.usage?.output_tokens != null) usage.output_tokens = event.usage.output_tokens;
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      }
    }

    if (stopReason === "tool_use") {
      return {
        text: null,
        schemaJson: null,
        tokensIn: usage.input_tokens,
        tokensOut: usage.output_tokens,
        needsToolExecution: true,
        response: { content, stop_reason: "tool_use" },
      };
    }
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return {
      text,
      schemaJson: null,
      tokensIn: usage.input_tokens,
      tokensOut: usage.output_tokens,
      needsToolExecution: false,
      response: null,
    };
  }

  estimateTokens(prompt: string): number {
    return Math.ceil((prompt || "").length / 3);
  }
}

function _shapeNonStreaming(resp: any, req: AdapterCompleteRequest): AdapterCompleteResponse {
  const usage = resp.usage || { input_tokens: 0, output_tokens: 0 };
  const tokensIn = usage.input_tokens || 0;
  const tokensOut = usage.output_tokens || 0;

  // Tool-use stop: hand the whole turn back so caller (handler.ts) can execute tools.
  if (resp.stop_reason === "tool_use") {
    return {
      text: null,
      schemaJson: null,
      tokensIn,
      tokensOut,
      needsToolExecution: true,
      response: { content: resp.content, stop_reason: "tool_use" },
    };
  }

  let text: string | null = null;
  if (Array.isArray(resp.content)) {
    const textBlock = resp.content.find((b: any) => b && b.type === "text");
    text = textBlock ? textBlock.text : null;
  }

  let schemaJson: unknown | null = null;
  if (req.schema && text) {
    try { schemaJson = JSON.parse(text); } catch (_e) { schemaJson = null; }
  }

  return { text, schemaJson, tokensIn, tokensOut, needsToolExecution: false, response: null };
}

export = { AnthropicAPIAdapter };
