"use strict";

// ai-gateway/adapters/openai-compat.ts
// OpenAI-compatible Chat Completions API.
//
// Covers: Gemini, DeepSeek, GPT, Mistral, Grok — any provider exposing
// /chat/completions with bearer auth. The adapter is provider-agnostic:
// model + baseUrl + apiKeyEnv come from the authz policy binding.
//
// Phase 3: non-streaming, non-tool, single prompt.
// Phase 4: streaming via SSE + tool_calls + messages[] + system prompt.
// Translates Anthropic-shape messages/tools into OpenAI shape and back so the
// gateway exposes one consistent API regardless of provider.

const { IAIAdapter } = require("../adapter-interface");

const REQUEST_TIMEOUT_MS = 60_000;

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | Array<Record<string, any>>;
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
  baseUrl?: string;
  apiKeyEnv?: string;
}

interface AdapterCompleteResponse {
  text: string | null;
  schemaJson: unknown | null;
  tokensIn: number;
  tokensOut: number;
  needsToolExecution?: boolean;
  response?: Record<string, unknown> | null;
}

// GPT-5 family rejects max_tokens; uses max_completion_tokens. Detect by id
// prefix (safe for non-OpenAI providers which don't use gpt-5 prefix).
function _maxTokensField(modelId: string): string {
  return /^gpt-5(\.|-)/i.test(String(modelId || "")) ? "max_completion_tokens" : "max_tokens";
}

// Convert Anthropic ToolSpec[] → OpenAI tools[] shape.
function _convertTools(tools: ToolSpec[]): any[] {
  return (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// Convert Anthropic-shape messages → OpenAI shape. Handles tool_result blocks
// and tool_use blocks. Mirrors src/app/llm/client.ts:convertMessagesToOpenAI.
function _convertMessages(messages: ChatMessage[], systemPrompt?: string): any[] {
  const result: any[] = [];
  if (systemPrompt) result.push({ role: "system", content: systemPrompt });

  for (const msg of messages) {
    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            result.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }
      } else {
        result.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        const reasoningParts = msg.content
          .filter((b) => b.type === "reasoning_content")
          .map((b: any) => b.text)
          .join("\n");
        const toolCalls = msg.content
          .filter((b) => b.type === "tool_use")
          .map((b: any) => ({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
        const m: any = {
          role: "assistant",
          content: textParts || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        };
        // DeepSeek thinking-mode requires echoing reasoning_content in
        // subsequent rounds. Other providers ignore unknown fields.
        if (reasoningParts) m.reasoning_content = reasoningParts;
        result.push(m);
      } else {
        result.push({ role: "assistant", content: msg.content });
      }
    } else if (msg.role === "system") {
      result.push({ role: "system", content: msg.content as string });
    }
  }
  return result;
}

class OpenAICompatAdapter extends IAIAdapter {
  get provider(): string {
    return "openai-compat";
  }

  async complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse> {
    const baseUrl = req.baseUrl;
    const apiKeyEnv = req.apiKeyEnv;
    if (!baseUrl) throw new Error("openai-compat: missing baseUrl in policy binding");
    if (!apiKeyEnv) throw new Error("openai-compat: missing apiKeyEnv in policy binding");
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`openai-compat: ${apiKeyEnv} not set`);

    const isChatMode = Array.isArray(req.messages);
    const openAIMessages = isChatMode
      ? _convertMessages(req.messages as ChatMessage[], req.systemPrompt)
      : (() => {
          const arr: any[] = [];
          if (req.systemPrompt) arr.push({ role: "system", content: req.systemPrompt });
          arr.push({ role: "user", content: String(req.prompt || "") });
          return arr;
        })();

    const body: Record<string, any> = {
      model: req.model,
      [_maxTokensField(req.model)]: req.maxOutputTokens,
      messages: openAIMessages,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = _convertTools(req.tools);
    }

    if (req.onDelta) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`openai-compat ${req.model} ${resp.status}: ${errText.slice(0, 200)}`);
    }

    // Streaming path.
    if (req.onDelta) {
      return await _consumeStream(resp, req);
    }

    // Non-streaming path.
    const data: any = await resp.json();
    const choice = data?.choices?.[0];
    const usage = {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    };

    // Tool_calls present → return assistant turn in Anthropic shape.
    if (choice?.finish_reason === "tool_calls" || choice?.message?.tool_calls?.length > 0) {
      const content: any[] = [];
      if (choice.message.reasoning_content) {
        content.push({ type: "reasoning_content", text: choice.message.reasoning_content });
      }
      if (choice.message.content) {
        content.push({ type: "text", text: choice.message.content });
      }
      for (const tc of choice.message.tool_calls || []) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: (() => { try { return JSON.parse(tc.function.arguments || "{}"); } catch { return {}; } })(),
        });
      }
      return {
        text: null,
        schemaJson: null,
        tokensIn: usage.input_tokens,
        tokensOut: usage.output_tokens,
        needsToolExecution: true,
        response: { content, stop_reason: "tool_use" },
      };
    }

    const text: string | null = choice?.message?.content ?? null;
    let schemaJson: unknown | null = null;
    if (req.schema && text) {
      try { schemaJson = JSON.parse(text); } catch (_e) { schemaJson = null; }
    }

    return {
      text,
      schemaJson,
      tokensIn: usage.input_tokens,
      tokensOut: usage.output_tokens,
      needsToolExecution: false,
      response: null,
    };
  }

  estimateTokens(prompt: string): number {
    return Math.ceil((prompt || "").length / 3.5);
  }
}

async function _consumeStream(
  resp: Response,
  req: AdapterCompleteRequest,
): Promise<AdapterCompleteResponse> {
  let text = "";
  let reasoning = "";
  const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
  let finishReason: string | null = null;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed: any;
      try { parsed = JSON.parse(payload); } catch (_e) { continue; }
      if (parsed.usage) {
        usage.input_tokens = parsed.usage.prompt_tokens || usage.input_tokens;
        usage.output_tokens = parsed.usage.completion_tokens || usage.output_tokens;
      }
      const c = parsed.choices?.[0];
      if (!c) continue;
      if (c.finish_reason) finishReason = c.finish_reason;
      const d = c.delta;
      if (!d) continue;
      if (d.content) {
        text += d.content;
        try { req.onDelta!(d.content); } catch (_e) { /* swallow */ }
      }
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: "", name: "", args: "" };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
        }
      }
    }
  }

  if (finishReason === "tool_calls" || Object.keys(toolCalls).length > 0) {
    const content: any[] = [];
    if (reasoning) content.push({ type: "reasoning_content", text: reasoning });
    if (text) content.push({ type: "text", text });
    for (const k of Object.keys(toolCalls).sort((a, b) => Number(a) - Number(b))) {
      const tc = toolCalls[Number(k)];
      let input = {};
      try { input = JSON.parse(tc.args || "{}"); } catch (_e) { /* {} */ }
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }
    return {
      text: null,
      schemaJson: null,
      tokensIn: usage.input_tokens,
      tokensOut: usage.output_tokens,
      needsToolExecution: true,
      response: { content, stop_reason: "tool_use" },
    };
  }

  return {
    text,
    schemaJson: null,
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    needsToolExecution: false,
    response: null,
  };
}

// Shared helpers exported for deepseek.ts (dedicated adapter) reuse — avoids
// duplicating the ~280-line Chat Completions request/stream logic just to
// change provider id + response_format tuning.
export = {
  OpenAICompatAdapter,
  _maxTokensField,
  _convertTools,
  _convertMessages,
  _consumeStream,
  REQUEST_TIMEOUT_MS,
};
