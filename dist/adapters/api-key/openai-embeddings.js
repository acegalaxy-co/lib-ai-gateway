"use strict";
// ai-gateway/adapters/openai-embeddings.ts
// Phase 3c adapter — OpenAI-compatible embeddings endpoint.
// Covers: OpenAI text-embedding-3-*, Gemini gemini-embedding-*, any provider
// exposing /v1/embeddings with bearer auth + OpenAI-shape response.
//
// Mirrors src/app/modules/rag/lib/embed.ts (which this replaces in Phase 3c).
// Sub-batches to BATCH inputs/call to keep request size sane.
const { IEmbedAdapter } = require("../adapter-interface");
const REQUEST_TIMEOUT_MS = 30_000;
const BATCH = 100;
class OpenAIEmbeddingsAdapter extends IEmbedAdapter {
    get provider() {
        return "openai-embeddings";
    }
    async embed(req) {
        const baseUrl = req.baseUrl;
        const apiKeyEnv = req.apiKeyEnv;
        if (!baseUrl)
            throw new Error("openai-embeddings: missing baseUrl in policy binding");
        if (!apiKeyEnv)
            throw new Error("openai-embeddings: missing apiKeyEnv in policy binding");
        const apiKey = process.env[apiKeyEnv];
        if (!apiKey)
            throw new Error(`openai-embeddings: ${apiKeyEnv} not set`);
        if (!Array.isArray(req.inputs) || req.inputs.length === 0) {
            throw new Error("openai-embeddings: inputs must be non-empty array");
        }
        const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;
        const vectors = [];
        let tokensIn = 0;
        for (let i = 0; i < req.inputs.length; i += BATCH) {
            const slice = req.inputs.slice(i, i + BATCH);
            const resp = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({ model: req.model, input: slice }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`openai-embeddings ${req.model} ${resp.status}: ${errText.slice(0, 200)}`);
            }
            const data = await resp.json();
            const items = Array.isArray(data?.data) ? data.data : [];
            // Preserve input order: API returns data[i].index → use it if present.
            const ordered = new Array(slice.length);
            for (let k = 0; k < items.length; k += 1) {
                const item = items[k];
                const idx = typeof item.index === "number" ? item.index : k;
                ordered[idx] = item.embedding;
            }
            for (const v of ordered)
                vectors.push(v);
            tokensIn += data?.usage?.prompt_tokens || 0;
        }
        return { vectors, tokensIn };
    }
    estimateTokens(inputs) {
        let total = 0;
        for (const s of inputs || [])
            total += Math.ceil((s || "").length / 4);
        return total;
    }
}
module.exports = { OpenAIEmbeddingsAdapter };
//# sourceMappingURL=openai-embeddings.js.map