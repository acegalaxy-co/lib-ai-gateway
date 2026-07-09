# @nexus/ai-gateway

In-repo runtime LLM call gateway. 5-layer default-deny. Mirrors `@nexus/ott-gateway` pattern (see [.claude/rules/system-ott.md](../../.claude/rules/system-ott.md)) for runtime AI calls instead of inbound OTT messages.

## Why

Every LLM call from Nexus runtime (skills, schedulers, handlers) MUST go through this gateway.
Direct `require("@anthropic-ai/sdk")` / `openai` / `claude` CLI subprocess outside `commons/ai-gateway/adapters/` is forbidden — see rule `.claude/rules/system-ai-gateway.md`.

## 5 layers (default-deny, in order)

```
callLLM(prompt, { skill, tier, schema? })
  ▶ L1 Adapter (provider verify + payload normalize)
  ▶ L2 Authz   (skill → allowed providers/models matrix)
  ▶ L3 Budget  (token quota per skill/day — reserve pre-call, commit post-call)
  ▶ L4 Circuit (per-provider failure trip — open after N consecutive 5xx)
  ▶ L5 Audit   (append-only JSONL: skill, provider, model, tokensIn/Out, latencyMs, outcome)
```

Deny reasons: `L1_provider_unavailable | L2_authz | L3_budget_exhausted | L4_circuit_open | L5_audit_fatal`.

## Status (current)

- ✅ 5-layer dispatch for text calls (`dispatchCall`) and embeddings (`dispatchEmbed`).
- ✅ Subscription flow: model registry rows with `type: "Subscription"` route to CLI adapters:
  - `anthropic` → `anthropic-cli`
  - `openai-compat` + Gemini model id → `gemini-cli`
  - `openai-compat` + Codex model id → `codex-cli`
- ✅ API Key flow: model registry rows with `type: "API Key"` route to REST adapters:
  - `anthropic` → `anthropic-api`
  - `openai-compat` → `openai-compat`
  - embeddings → `openai-embeddings`
- ✅ `src/app/llm/client.ts`, `src/app/llm/claude-cli.ts`, and RAG embeddings route runtime calls through this gateway.
- 🚧 Remaining audit: direct model catalog/health probes and any legacy runtime bypasses outside `commons/ai-gateway/` must be migrated or explicitly classified as non-runtime probes before enforcement is tightened.

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
const { dispatchCall } = require("@nexus/ai-gateway");

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

## Model selection

Priority (high → low):

1. `req.modelOverride` param — caller code picks provider + model
2. `NEXUS_AI_GATEWAY_MODEL_<SKILL>` env var — skill-specific runtime (Anthropic only)
3. `NEXUS_AI_GATEWAY_MODEL_DEFAULT` env var — all Anthropic skills fallback
4. Policy tier binding in `authz/policies.json`

Skill name → env var: uppercase, `.` and `-` → `_`. Example `crawler.extract` → `NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT`.

Env override applies ONLY to Anthropic providers (`anthropic-api`, `anthropic-cli`). Skills bound `openai-compat` (DeepSeek/Gemini) are untouched — cross-provider swap needs `baseUrl` + `apiKeyEnv` which env vars can't carry.

```bash
# Run crawler with Haiku for one session
NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT=claude-haiku-4-5 npm run start artist-search

# Rollback all Anthropic skills to Sonnet
NEXUS_AI_GATEWAY_MODEL_DEFAULT=claude-sonnet-4-6 node server.js
```

## Files

```
commons/ai-gateway/
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
    policies.json             # matrix config
  rate-limit/
    budget.ts                 # per-skill daily token quota
    circuit-breaker.ts        # per-provider failure trip
  audit/
    logger.ts                 # append-only JSONL (audit.log gitignored)
  lib/
    audit-log/index.ts        # shared sliding append (clone OTT)
    rate-limit/index.ts       # shared sliding window (clone OTT)
```

## Audit log

- Path: `commons/ai-gateway/audit/audit.log` (gitignored — may contain prompt hashes/PII)
- Format: JSON lines, one `OutcomeRecord` per call
- Override: `AI_GATEWAY_AUDIT_LOG_PATH`
- Retention: never delete (archive OK)
