# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.3.0]

### Added

- gemini-cli adapter now accepts browse options so the gateway can own the
  `gemini` CLI spawn that consumers (e.g. kane-crawler) used to spawn
  themselves — a violation of the "CLI spawns live only in gateway adapters"
  rule: `cwd` (spawn cwd, so gemini picks up the project-scope
  `.gemini/settings.json` MCP servers), `yolo` (`--yolo`), `outputJson`
  (`-o json`, parses the CLI's JSON envelope for the model text —
  `response` → `result` → `text` — and rejects with
  `gemini -o json returned non-JSON envelope` if the envelope itself isn't
  JSON), `allowedMcpServerNames` (`--allowed-mcp-server-names <name>` per
  entry), `coreTools` (written to a temp file, passed via
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, removed after the process closes).
  `AICallRequest` in `index.ts` passes these through unchanged. All optional;
  unset → identical argv/behaviour to 1.2.0.
- Schema parsing (both anthropic-cli and gemini-cli) now falls back to
  extracting the first `[...]`/`{...}` block when fence-stripped text still
  isn't valid JSON.

### Fixed

- anthropic-cli and gemini-cli adapters spawn with `detached: true` and run
  their own timeout timer that SIGKILLs the whole process group
  (`process.kill(-child.pid, "SIGKILL")`, falling back to `child.kill()`)
  instead of relying on `spawn(..., { timeout })`, which only killed the
  direct child. MCP server children (CloakBrowser/Chromium) previously
  survived a timeout and kept the browser profile locked. Timeout rejection
  messages (`claude killed (SIGKILL) — timeout?` / `gemini killed (SIGKILL)
  — timeout?`) are unchanged so existing error classification keeps working.

## [1.2.0]

### Added

- `AICallRequest.timeoutMs` — optional per-call override of the policy
  binding's `timeoutMs`. `dispatchCall` now passes
  `req.timeoutMs ?? authzResult.timeoutMs` to `adapter.complete()` (falls
  back to the policy value when unset or not a positive finite number).
  Fixes callers whose task genuinely needs more/less time than the skill's
  policy default (e.g. kane-crawler's `nhadathue-search` needs 7min but
  `crawler.extract`'s policy binding is 300000ms) getting SIGKILLed by the
  adapter subprocess at the policy timeout regardless of what the caller
  requested.

### Fixed

- 31 pre-existing failing tests (mislabeled "env-dependent") across
  `dispatch.test.js`, `chat-mode.test.js`, `dispatch-embed.test.js`,
  `vendor-endpoint.test.js` and `env-model-resolve.test.js`. Real cause: these
  tests exercise `authz/engine.ts` modelKey resolution (`sonnet_api`,
  `sonnet_cli`, `haiku_api`, `gemini_cli`, `gemini_api`, `codex_cli`,
  `deepseek_api`, referenced by `authz/policies.json`), which reads the
  repo-committed Layer 2 registry fallback `config/llm-config.json` — a fixture
  the test suite never shipped after this package was split out of the Nexus
  monorepo, so every modelKey lookup failed with `not in llmModels registry`.
  Added the missing fixture under `test/fixtures/config-root/config/llm-config.json`
  (not under the package's real `config/`, which must stay free of registry
  data — `authz/engine.ts` `_repoRoot()` walks up from `__dirname` and, in a
  consumer's `node_modules/@acegalaxy/lib-ai-gateway/`, would otherwise find
  this package's own `config/llm-config.json` before reaching the consumer's
  real repo root, silently shadowing its production model registry).
  `test/setup-env.cjs`, preloaded via `npm test`'s `--require` flag, points
  `AI_GATEWAY_CONFIG_ROOT` at the fixture directory before any test file loads
  the engine. No `src`/adapter logic changed. `npm test` now passes
  123/123, including hermetically (`env -i npm test`).
