"use strict";
// commons/ai-gateway/lib/claude-limit/index.ts
// Barrel re-export so consumers import ONE subpath instead of reaching into
// 4 internal files. Required for the package `exports` map (Phase B shared
// repo) — external consumers must not deep-import individual modules.
const detect = require("./detect");
const state = require("./state");
const error = require("./error");
const alert = require("./alert");
module.exports = {
    ...detect, // detectClaudeLimit, limitKindLabel
    ...state, // markLimitHit, shouldSkip, clearLimit, getActiveLimits
    ...error, // ClaudeCliLimitError
    ...alert, // alertClaudeCliLimit, _clearAlertCooldown
};
//# sourceMappingURL=index.js.map