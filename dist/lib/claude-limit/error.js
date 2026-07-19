"use strict";
// claude-limit/error.ts
// ClaudeCliLimitError — structured exception for Claude CLI limit hits.
const { limitKindLabel } = require("./detect");
class ClaudeCliLimitError extends Error {
    kind;
    resetAt;
    skill;
    raw;
    isClaudeCliLimit;
    constructor(skill, match) {
        const resetLabel = match.resetAt
            ? new Date(match.resetAt).toISOString()
            : "unknown";
        const kindLabel = limitKindLabel(match.kind);
        super(`Claude CLI limit hit (${kindLabel}), reset at ${resetLabel}`);
        this.name = "ClaudeCliLimitError";
        this.kind = match.kind || null;
        this.resetAt = match.resetAt || null;
        this.skill = skill;
        this.raw = match.raw || "";
        this.isClaudeCliLimit = true;
        // Maintain stack trace
        if (typeof Error.captureStackTrace === "function") {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}
module.exports = { ClaudeCliLimitError };
//# sourceMappingURL=error.js.map