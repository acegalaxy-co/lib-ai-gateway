"use strict";

// ai-gateway/audit/logger.ts
// L5 — Audit log. Append-only JSONL. Mirrors ott-gateway/audit/logger.ts.

import path = require("path");
import fs = require("fs");
const { createAuditLogger } = require("../lib/audit-log");

// Resolve audit dir to the source tree, regardless of whether this file is
// being loaded from `audit/logger.ts` (tsx/dev) or `dist/audit/logger.js` (built).
// We walk up looking for package.json to anchor on the package root.
function _packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "..");
}

const _defaultPath = path.join(_packageRoot(), "audit", "audit.log");
try { fs.mkdirSync(path.dirname(_defaultPath), { recursive: true }); } catch (_e) { /* swallow */ }

const logger = createAuditLogger({
  logPath: process.env.AI_GATEWAY_AUDIT_LOG_PATH || _defaultPath,
  tag: "ai-gateway][audit",
  mode: "async",
});

export = { record: logger.record, LOG_PATH: logger.LOG_PATH };
