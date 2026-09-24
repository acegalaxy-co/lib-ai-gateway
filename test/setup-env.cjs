"use strict";

// test/setup-env.cjs
// Preloaded via `npm test`'s --require flag, before any test file (and thus
// before any dist/ module) loads. Points authz/engine.ts's _repoRoot() /
// lib/proxy-override's config lookup at the hermetic test fixture instead of
// walking up the real filesystem — see authz/engine.ts _repoRoot() for why
// that walk is otherwise unsafe for consumers (it would find THIS package's
// own config/llm-config.json inside node_modules before reaching the
// consumer's real repo root). test/fixtures/config-root is never shipped
// (test/ is excluded from package.json "files").
process.env.AI_GATEWAY_CONFIG_ROOT = require("path").join(
  __dirname,
  "fixtures",
  "config-root",
);
