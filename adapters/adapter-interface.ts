"use strict";

// ai-gateway/adapters/adapter-interface.ts
// Abstract base classes — every AI provider adapter MUST extend one of these.
// Mirrors ott-gateway/adapters/adapter-interface.ts shape.
//
// Two adapter kinds:
//   - IAIAdapter      → text completion (prompt → text). Used by dispatchCall().
//   - IEmbedAdapter   → embedding (text[] → vector[]). Used by dispatchEmbed().
// A provider can extend BOTH if it serves both (e.g. OpenAI does completion + embed).

interface AdapterCompleteRequest {
  prompt: string;
  model: string;
  maxOutputTokens: number;
  schema?: Record<string, unknown> | null;
}

interface AdapterCompleteResponse {
  text: string | null;
  schemaJson: unknown | null;
  tokensIn: number;
  tokensOut: number;
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
