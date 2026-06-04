"use strict";

// ai-gateway/adapters/openai-compat.ts
// Phase 3 adapter — OpenAI-compatible Chat Completions API.
// Covers: Gemini (generativelanguage.googleapis.com), DeepSeek, GPT (OpenAI),
// Mistral, Grok, Qwen — any provider exposing /chat/completions with bearer auth.
//
// The adapter is provider-agnostic: model + baseUrl + apiKeyEnv come from the
// authz policy binding. policies.json drives which provider is picked per skill.
//
// Phase 3 scope: non-streaming, non-tool-use. Streaming + tools live in
// src/app/llm/client.ts until Phase 3b cut over (when handler.ts migrates).

const { IAIAdapter } = require("./adapter-interface");

const REQUEST_TIMEOUT_MS = 60_000;

interface AdapterCompleteRequest {
  prompt: string;
  model: string;
  maxOutputTokens: number;
  schema?: Record<string, unknown> | null;
  // Provider-specific knobs injected via policies.json binding (see authz/engine.ts).
  baseUrl?: string;
  apiKeyEnv?: string;
}

interface AdapterCompleteResponse {
  text: string | null;
  schemaJson: unknown | null;
  tokensIn: number;
  tokensOut: number;
}

// OpenAI's GPT-5 family rejects `max_tokens` and requires `max_completion_tokens`
// instead. Detect by id prefix; safe for non-OpenAI openai-compat endpoints because
// they don't use the gpt-5 prefix. Mirrored from src/app/llm/client.ts:_maxTokensField.
function _maxTokensField(modelId: string): string {
  return /^gpt-5(\.|-)/i.test(String(modelId || "")) ? "max_completion_tokens" : "max_tokens";
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

    const body: Record<string, unknown> = {
      model: req.model,
      [_maxTokensField(req.model)]: req.maxOutputTokens,
      messages: [{ role: "user", content: req.prompt }],
    };

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

    const data: any = await resp.json();
    const choice = data?.choices?.[0];
    const text: string | null = choice?.message?.content ?? null;

    let schemaJson: unknown | null = null;
    if (req.schema && text) {
      try { schemaJson = JSON.parse(text); } catch (_e) { schemaJson = null; }
    }

    const tokensIn = data?.usage?.prompt_tokens || 0;
    const tokensOut = data?.usage?.completion_tokens || 0;

    return { text, schemaJson, tokensIn, tokensOut };
  }

  estimateTokens(prompt: string): number {
    // Cross-provider heuristic: 3.5 chars/token.
    return Math.ceil((prompt || "").length / 3.5);
  }
}

export = { OpenAICompatAdapter };
