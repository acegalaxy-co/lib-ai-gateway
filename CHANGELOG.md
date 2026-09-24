# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
