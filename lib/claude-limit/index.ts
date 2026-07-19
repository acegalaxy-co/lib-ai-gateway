"use strict";

// commons/ai-gateway/lib/claude-limit/index.ts
// Barrel re-export so consumers import ONE subpath instead of reaching into
// 4 internal files. Required for the package `exports` map (Phase B shared
// repo) — external consumers must not deep-import individual modules.

import detect = require("./detect");
import state = require("./state");
import error = require("./error");
import alert = require("./alert");

export = {
  ...detect, // detectClaudeLimit, limitKindLabel
  ...state, // markLimitHit, shouldSkip, clearLimit, getActiveLimits
  ...error, // ClaudeCliLimitError
  ...alert, // alertClaudeCliLimit, _clearAlertCooldown
};
