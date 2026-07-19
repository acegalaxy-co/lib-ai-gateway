"use strict";
class IAIAdapter {
    get provider() {
        throw new Error("abstract");
    }
    // eslint-disable-next-line no-unused-vars
    async complete(req) {
        throw new Error("abstract");
    }
    // eslint-disable-next-line no-unused-vars
    estimateTokens(prompt) {
        // Default heuristic: 4 chars per token (rough). Adapters may override.
        return Math.ceil((prompt || "").length / 4);
    }
}
class IEmbedAdapter {
    get provider() {
        throw new Error("abstract");
    }
    // eslint-disable-next-line no-unused-vars
    async embed(req) {
        throw new Error("abstract");
    }
    // eslint-disable-next-line no-unused-vars
    estimateTokens(inputs) {
        let total = 0;
        for (const s of inputs || [])
            total += Math.ceil((s || "").length / 4);
        return total;
    }
}
module.exports = { IAIAdapter, IEmbedAdapter };
//# sourceMappingURL=adapter-interface.js.map