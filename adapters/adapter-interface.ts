"use strict";

// ai-gateway/adapters/adapter-interface.ts
// Abstract base classes — every AI provider adapter MUST extend one of these.
// Mirrors ott-gateway/adapters/adapter-interface.ts shape.
//
// Two adapter kinds:
//   - IAIAdapter      → text completion (prompt → text). Used by dispatchCall().
//   - IEmbedAdapter   → embedding (text[] → vector[]). Used by dispatchEmbed().
// A provider can extend BOTH if it serves both (e.g. OpenAI does completion + embed).

// Two ways to call complete():
//   - prompt-mode (Phase 1-3): single user prompt, no streaming, no tools.
//   - chat-mode (Phase 4): messages[] conversation, optional streaming + tools
//     for handler/telegram-bot flow.
// Adapters check which fields are present; both modes coexist behind the same
// method signature so dispatchCall keeps one entry point.
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
  // Prompt-mode (legacy):
  prompt?: string;
  // Chat-mode (Phase 4):
  messages?: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolSpec[];
  onDelta?: (text: string) => void;     // present → streaming

  // Common:
  model: string;
  maxOutputTokens: number;
  schema?: Record<string, unknown> | null;
  // Optional skill identifier — used by anthropic-cli for limit tracking
  skill?: string;
  // Endpoint override (per-vendor LLM endpoint switch, 2026-07-10). Empty/unset
  // → adapter's own direct/default endpoint. Non-empty → route through this
  // base URL (e.g. 9router proxy). Resolved by authz/engine.ts from
  // NEXUS_<VENDOR>_BASE_URL. See .claude/rules/system-ai-gateway.md.
  baseUrl?: string;
}

interface AdapterCompleteResponse {
  text: string | null;
  schemaJson: unknown | null;
  tokensIn: number;
  tokensOut: number;
  // Chat-mode extras (null when prompt-mode):
  needsToolExecution?: boolean;          // true → response.content has tool_use blocks
  response?: Record<string, unknown> | null;  // raw assistant turn (content blocks + stop_reason)
}

interface AdapterEmbedRequest {
  inputs: string[];             // batch — adapter may sub-batch internally
  model: string;
  // Provider extras (injected from policy binding):
  baseUrl?: string;
  apiKeyEnv?: string;
}

interface AdapterEmbedResponse {
  vectors: number[][];          // one vector per input, same order
  tokensIn: number;             // total input tokens billed
}

class IAIAdapter {
  get provider(): string {
    throw new Error("abstract");
  }

  // eslint-disable-next-line no-unused-vars
  async complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse> {
    throw new Error("abstract");
  }

  // eslint-disable-next-line no-unused-vars
  estimateTokens(prompt: string): number {
    // Default heuristic: 4 chars per token (rough). Adapters may override.
    return Math.ceil((prompt || "").length / 4);
  }
}

class IEmbedAdapter {
  get provider(): string {
    throw new Error("abstract");
  }

  // eslint-disable-next-line no-unused-vars
  async embed(req: AdapterEmbedRequest): Promise<AdapterEmbedResponse> {
    throw new Error("abstract");
  }

  // eslint-disable-next-line no-unused-vars
  estimateTokens(inputs: string[]): number {
    let total = 0;
    for (const s of inputs || []) total += Math.ceil((s || "").length / 4);
    return total;
  }
}

export = { IAIAdapter, IEmbedAdapter };
