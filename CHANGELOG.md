# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.6.0]

### Changed

- `anthropic-cli` slim mode for skills `crawler.extract` / `crawler.join`:
  `--system-prompt` (built-in safety rules + caller `systemPrompt`),
  `--tools ""`, `--disable-slash-commands`, `--strict-mcp-config`, spawn in an
  empty tmp cwd (no caller CLAUDE.md/project settings). Fixed per-request
  context measured 54.9k → 1.4k tokens; MCP tools still work. `--mcp-config`
  path is now resolved absolute. Kill switch: `AI_GATEWAY_CLI_SLIM=0`.

## [1.5.0]

### Added

- Provider `antigravity-cli`: reuses `AnthropicCLIAdapter` (Claude Code CLI)
  for Gemini models routed by a proxy (`--model antigravity/<model>`). Has its
  own circuit breaker (keyed by provider string) and its own per-skill
  limit-cooldown key (`antigravity-cli:<skill>`), so it stays usable when the
  Claude provider is failing or rate-limited. Model id is passed to the CLI
  verbatim (no alias normalization). Select via
  `modelOverride: { provider: "antigravity-cli", model: "antigravity/<model>" }`.
  `AnthropicCLIAdapter` now accepts an optional `{ provider }` constructor arg;
  default (`anthropic-cli`) behavior is unchanged.

## [1.4.0]

### Added

- Provider remap via env: `AI_GATEWAY_REMAP_<PROVIDER>` (PROVIDER = provider
  string uppercased, `-`→`_`) redirects every call that resolves to that
  provider — tier binding, `modelOverride`, env-model-override, or the
  policy `*` default — to a different `llmModels` registry row, entirely via
  env (no hardcoded model/url/key in the lib). Use case: PROD Anthropic API
  credit exhausted → set `AI_GATEWAY_REMAP_ANTHROPIC_API=codex_api` (or any
  other registry modelKey) to reroute without touching `policies.json` or
  shipping a code change. Single hop only (no chains/loops); unknown/inactive
  (for cost-metered providers) remap target denies with `L2_remap_invalid`
  instead of silently keeping the original provider. Applied after
  modelOverride/env-override, before the proxy-override layer, so the remap
  target's own family (anthropic/deepseek/codex) still gets proxy-routed
  normally. `authz/engine.ts` now exports `resolveModelKey()` — the
  type-aware registry→provider resolution previously inlined in `check()` —
  reused by both the tier-binding path and the remap path. Outcome/response
  gain `remappedFrom: <original provider>` when a remap applied.

### Fixed

- `openai-compat` adapter's gpt-5 `max_completion_tokens` detection now
  strips a leading proxy prefix (e.g. `cx/gpt-5.5`) before testing — a
  proxied/remapped gpt-5 model id was silently sent with `max_tokens`
  instead, which OpenAI rejects for that family. Shared by the DeepSeek
  adapter (reuses this helper) and anything resolving through the `codex`
  proxy-override family.

## [1.3.1]

### Fixed

- gemini-cli `coreTools` setting used the flat `{"coreTools":[...]}` schema,
  which gemini CLI >=0.4x silently ignores — tool restriction was
  ineffective (verified live: shell stayed enabled under `--yolo`, a real
  `touch` call succeeded). Now writes the nested `{"tools":{"core":[...]}}`
  schema, which the CLI actually enforces (verified: model reports no shell
  tool, no file created). Request field name (`coreTools`) unchanged.

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
