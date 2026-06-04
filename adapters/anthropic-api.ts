"use strict";

// ai-gateway/adapters/anthropic-api.ts
// Phase 1 adapter — Anthropic Messages API via @anthropic-ai/sdk.
// Key from env: ANTHROPIC_API_KEY (read inside adapter, never logged).

const { IAIAdapter } = require("./adapter-interface");

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

let _client: any = null;

function _getClient(): any {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.NEXUS_ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  // Lazy require — SDK only loaded when first call hits this adapter.
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
    const resp = await client.messages.create({
      model: req.model,
      max_tokens: req.maxOutputTokens,
      messages: [{ role: "user", content: req.prompt }],
    });

    // Extract text from content blocks.
    let text: string | null = null;
    if (Array.isArray(resp.content)) {
      const textBlock = resp.content.find((b: any) => b && b.type === "text");
      text = textBlock ? textBlock.text : null;
    }

    let schemaJson: unknown | null = null;
    if (req.schema && text) {
      try {
        schemaJson = JSON.parse(text);
      } catch (_e) {
        schemaJson = null;
      }
    }

    const tokensIn = (resp.usage && resp.usage.input_tokens) || 0;
    const tokensOut = (resp.usage && resp.usage.output_tokens) || 0;

    return { text, schemaJson, tokensIn, tokensOut };
  }

  estimateTokens(prompt: string): number {
    // Anthropic rule of thumb: ~3.5 chars/token for English, ~2 for CJK/VN.
    // Conservative: 3 chars/token.
    return Math.ceil((prompt || "").length / 3);
  }
}

export = { AnthropicAPIAdapter };
