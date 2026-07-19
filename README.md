# @acegalaxy/ai-gateway

Shared runtime LLM call gateway. 5-layer default-deny. Extracted from ACE Nexus
so multiple projects consume one gateway and updates land in one place.

**Private** — `authz/policies.json` (skill names + quotas) and `config/proxy.json`
(internal proxy/env wiring) are internal architecture. Do NOT publish to a public
registry. Consume via git-dependency only.

## Consume (git-dependency)

Ships prebuilt `dist/` — no build step in the consumer.

```jsonc
// consumer package.json
"dependencies": {
  "@acegalaxy/ai-gateway": "git+ssh://git@github.com:acegalaxy-co/ai-gateway.git#v1.0.0"
}
```

Pin a tag (`#v1.0.0`), not a branch. Bump the tag to upgrade. Private repo → the
install host needs SSH/deploy-key access to `acegalaxy-co/ai-gateway`.

```ts
const { dispatchCall } = require("@acegalaxy/ai-gateway");
// subpath exports:
const claudeLimit = require("@acegalaxy/ai-gateway/lib/claude-limit");
const auditLogger = require("@acegalaxy/ai-gateway/audit/logger");
```

## Consumer contract — required env

| Env | Purpose | Default if unset |
|---|---|---|
| `AI_GATEWAY_CONFIG_ROOT` | Dir containing `config/llm-config.json` + `data/llm-models-cache.json` (the shared model registry, Notion-synced by the consumer). Point at the consumer repo root. | walk-up from package location — unreliable inside `node_modules`, so set it explicitly |
| `AI_GATEWAY_AUDIT_LOG_PATH` | Absolute path for the append-only audit log. **Set this OUTSIDE `node_modules`** (e.g. `<repo>/data/ai-gateway-audit.log`) — `npm install` wipes `node_modules`, taking any log inside it. | `<package>/audit/audit.log` (lost on reinstall) |
| `AI_GATEWAY_PROXY_CONFIG` | Explicit path to a `proxy.json` override. | `AI_GATEWAY_CONFIG_ROOT/config/proxy.json`, then package's own `config/proxy.json` |

The gateway resolves the model registry (provider, model id, baseUrl, apiKeyEnv)
from `config/llm-config.json` + `data/llm-models-cache.json` under `AI_GATEWAY_CONFIG_ROOT`.
Provider API keys are read at call time from `process.env` (names declared per model
in the registry) — never passed through the gateway API.

## 5 layers (default-deny, in order)

```text
dispatchCall({ skill, tier, prompt, schema? })
  ▶ L1 Adapter (provider verify + payload normalize)
  ▶ L2 Authz   (skill → allowed providers/models matrix)
  ▶ L3 Budget  (token quota per skill/day — reserve pre-call, commit post-call)
  ▶ L4 Circuit (per-provider failure trip — open after N consecutive 5xx)
  ▶ L5 Audit   (append-only JSONL: skill, provider, model, tokensIn/Out, latencyMs, outcome)
```

Deny reasons: `L1_provider_unavailable | L2_authz | L3_budget_exhausted | L4_circuit_open | L5_audit_fatal`.

## Contract

Every provider adapter MUST extend `IAIAdapter` (`adapters/adapter-interface.ts`):

```ts
class IAIAdapter {
  get provider(): string;          // "anthropic-api" | "anthropic-cli" | "openai-api" | ...
  async complete(req: AICallRequest): Promise<AICallResponse>;
  estimateTokens(prompt: string): number;
}
```

## Entry point

```ts
const { dispatchCall } = require("@acegalaxy/ai-gateway");

const result = await dispatchCall({
  skill: "invoice-enrich.summarize",
  tier: "fast",                    // "fast" | "balanced" | "deep"
  prompt: "Summarize: ...",
  schema: null,
});

// result.outcome === "allow" → result.text + result.tokensOut + result.latencyMs
// result.outcome === "deny"  → result.denyReason + result.latencyMs
```

`dispatchCall` NEVER throws. Always returns `{outcome, denyReason?, text?, tokensIn?, tokensOut?, latencyMs}`.

## Claude CLI limit alerts — inject transport

`lib/claude-limit/` detects Session-5h / Weekly-7d / rate limits from CLI stderr.
`alertClaudeCliLimit(scheduler, skill, kind, resetAt, sendAlert)` takes an injected
`sendAlert(message, channelId)` — the gateway does NOT reach into the consumer to
resolve a notify/telegram module. The consumer passes its own transport.

## Model selection

Priority (high → low):

1. `req.modelOverride` param — caller code picks provider + model
2. `NEXUS_AI_GATEWAY_MODEL_<SKILL>` env var — skill-specific runtime (Anthropic only)
3. `NEXUS_AI_GATEWAY_MODEL_DEFAULT` env var — all Anthropic skills fallback
4. Policy tier binding in `authz/policies.json`

Skill name → env var: uppercase, `.` and `-` → `_`. Example `crawler.extract` → `NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT`.

Env override applies ONLY to Anthropic providers (`anthropic-api`, `anthropic-cli`). Skills bound `openai-compat` (DeepSeek/Gemini) are untouched — cross-provider swap needs `baseUrl` + `apiKeyEnv` which env vars can't carry.

## Files

```text
index.ts                    # dispatchCall() — 5-layer entry
types.ts                    # AICallRequest, AICallResponse, OutcomeRecord
adapters/
  adapter-interface.ts      # IAIAdapter / IEmbedAdapter abstract contracts
  anthropic-api.ts          # Anthropic Messages API, API-key flow
  anthropic-cli.ts          # Claude CLI subscription flow
  gemini-cli.ts             # Gemini CLI subscription flow
  codex-cli.ts              # Codex CLI subscription flow
  openai-compat.ts          # OpenAI-compatible chat completions API flow
  openai-embeddings.ts      # OpenAI-compatible embeddings API flow
authz/
  engine.ts                 # skill+provider+model → allow/deny
  policies.json             # matrix config (skill names + quotas — internal)
rate-limit/
  budget.ts                 # per-skill daily token quota
  circuit-breaker.ts        # per-provider failure trip
audit/
  logger.ts                 # append-only JSONL (audit.log path via env)
lib/
  claude-limit/             # CLI usage-limit detect/state/error/alert (barrel)
  proxy-override/           # original-API vs 9router proxy endpoint resolve
  env/                      # LOCAL vs PROD detection
  audit-log/                # shared sliding append
  rate-limit/               # shared sliding window
config/
  proxy.json                # per-family proxy/env wiring (internal)
```

## Proxy config

`lib/proxy-override/` resolves original-API-vs-9router-proxy endpoint + model-id
prefix (`cc/`, `ds/`, `cx/`) per family (anthropic, deepseek, codex). Family
knobs (prefix, original hosts, match rule, `baseUrlEnv` list, proxy-enable flag
env, token-switch behavior) live in `config/proxy.json`. `.env` controls behavior
at runtime (`NEXUS_CLAUDE_BASE_URL`, `NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE`,
etc.) — `config/proxy.json` only declares which env vars matter per family and how
they combine.

Load priority: `AI_GATEWAY_PROXY_CONFIG` > `AI_GATEWAY_CONFIG_ROOT/config/proxy.json`
> co-located `config/proxy.json` (dist tree after `copy-assets`, or source tree).
Missing/malformed file falls back to an in-code default (same values) — the gateway
never throws on this path. `lib/env/index.ts` reads the same config's `localDetect`
block for LOCAL vs PROD detection.

## Audit log

- Path: `AI_GATEWAY_AUDIT_LOG_PATH` (set outside `node_modules` — see contract above)
- Fallback: `<package>/audit/audit.log` (gitignored; lost on reinstall)
- Format: JSON lines, one `OutcomeRecord` per call
- Retention: never delete (archive OK)

## Build / test (maintainers)

```bash
npm install
npm run build      # tsc + copy authz/config assets into dist/
npm test           # node --test, 123 tests
```

`dist/` is committed so consumers pull a ready-to-run tree. Rebuild + recommit
`dist/` before tagging a release.
