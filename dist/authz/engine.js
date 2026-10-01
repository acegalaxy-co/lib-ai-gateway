"use strict";
// ai-gateway/authz/engine.ts
// L2 — Authz: skill + tier → allowed provider+model. Default-deny.
// Mirrors ott-gateway/authz/engine.ts shape (identity→command → skill→tier).
//
// modelKey resolution (2026-07-09):
// A tier binding may specify `modelKey` instead of raw `model`+`provider`+
// `baseUrl`+`apiKeyEnv`. When set, the fields are resolved from the shared
// llmModels registry — Layer 1 `data/llm-models-cache.json` (synced from
// Notion 'Nexus_LLM Models' by src/app/llm/client.ts every 5 min), Layer 2
// `config/llm-config.json` (repo-committed fallback). Any explicit field on
// the binding overrides the resolved value. If modelKey unset, the legacy
// `model` path is used verbatim (backward compat).
const path = require("path");
const fs = require("fs");
// Providers metered by external API cost — a registry row marked `active:
// false` for one of these blocks the call. Anthropic CLI (session
// subscription) + Anthropic API are exempt: Nexus keeps their registry row
// `active=false` while PROD credit is zero, but the subscription-tier CLI
// still runs fine, and a straight API-key row is not itself the thing going
// stale. Shared by check() (tier-binding modelKey) and index.ts (env remap)
// so both paths agree on what counts as "invalid".
const COST_METERED_PROVIDERS = new Set(["openai-compat", "openai-embeddings", "deepseek-api"]);
function _isCostMetered(provider) {
    return COST_METERED_PROVIDERS.has(provider);
}
let _policies = null;
let _models = null;
let _modelsLoadedAt = 0;
const MODELS_TTL_MS = 5 * 60 * 1000;
function _packageRoot() {
    let dir = __dirname;
    for (let i = 0; i < 6; i += 1) {
        if (fs.existsSync(path.join(dir, "package.json")))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return path.resolve(__dirname, "..");
}
// Walk up from __dirname until we find a directory containing a top-level
// `config/llm-config.json` or `data/llm-models-cache.json`. Tests can override
// via env AI_GATEWAY_CONFIG_ROOT to point at a fixture directory.
function _repoRoot() {
    const override = process.env.AI_GATEWAY_CONFIG_ROOT;
    if (override && fs.existsSync(override))
        return override;
    let dir = __dirname;
    for (let i = 0; i < 8; i += 1) {
        if (fs.existsSync(path.join(dir, "config", "llm-config.json")))
            return dir;
        if (fs.existsSync(path.join(dir, "data", "llm-models-cache.json")))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return path.resolve(__dirname, "..", "..", "..");
}
function _load() {
    if (_policies)
        return _policies;
    // Prefer co-located policies.json (works in both source & dist tree after copy-assets);
    // fall back to source path under package root if not co-located.
    const here = path.join(__dirname, "policies.json");
    const root = path.join(_packageRoot(), "authz", "policies.json");
    const target = fs.existsSync(here) ? here : root;
    _policies = require(target);
    return _policies;
}
function _loadModels() {
    const now = Date.now();
    if (_models && now - _modelsLoadedAt < MODELS_TTL_MS)
        return _models;
    const repo = _repoRoot();
    // Layer 1: Notion-synced cache (written by src/app/llm/client.ts every 5min).
    const cachePath = path.join(repo, "data", "llm-models-cache.json");
    // Layer 2: repo-committed fallback.
    const configPath = path.join(repo, "config", "llm-config.json");
    let raw = null;
    try {
        if (fs.existsSync(cachePath)) {
            raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        }
    }
    catch (_e) {
        raw = null;
    }
    if (!raw || !raw.models || Object.keys(raw.models).length === 0) {
        try {
            raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
        }
        catch (_e) {
            raw = { models: {} };
        }
    }
    _models = (raw && raw.models) || {};
    _modelsLoadedAt = now;
    return _models;
}
// Test helper — return active layer name (used by tests only).
function _modelsSource() {
    const repo = _repoRoot();
    const cachePath = path.join(repo, "data", "llm-models-cache.json");
    const configPath = path.join(repo, "config", "llm-config.json");
    try {
        if (fs.existsSync(cachePath)) {
            const j = JSON.parse(fs.readFileSync(cachePath, "utf8"));
            if (j && j.models && Object.keys(j.models).length > 0)
                return "cache";
        }
    }
    catch (_e) { /* fall through */ }
    try {
        if (fs.existsSync(configPath))
            return "config";
    }
    catch (_e) { /* fall through */ }
    return "empty";
}
// Resolve a llmModels registry row (`data/llm-models-cache.json` / fallback
// `config/llm-config.json`) into the provider+model+baseUrl+apiKeyEnv the
// gateway should dial, applying the same type-aware routing rule check()
// uses for a tier binding's `modelKey`:
//   - Subscription anthropic        → anthropic-cli
//   - Subscription openai-compat    → gemini-cli (id startsWith "gemini") |
//                                      codex-cli (id "o1"/"gpt-5-codex*"/"gpt-5*") |
//                                      openai-compat (otherwise)
//   - API Key anthropic             → anthropic-api
//   - API Key deepseek-api          → deepseek-api (no-op passthrough)
//   - anything else                 → row.provider verbatim
// Returns null if modelKey isn't in the registry. Caller decides whether
// `active: false` blocks the call (see _isCostMetered — differs between a
// tier binding and a remap target no caller-visible difference today, but
// kept as the caller's call so both sites stay in one place for the rule).
function resolveModelKey(modelKey) {
    const registry = _loadModels();
    const row = registry[modelKey];
    if (!row || !row.id)
        return null;
    let effectiveProvider = row.provider;
    if (row.type === "Subscription") {
        if (row.provider === "anthropic")
            effectiveProvider = "anthropic-cli";
        else if (row.provider === "openai-compat") {
            if (row.id && row.id.startsWith("gemini"))
                effectiveProvider = "gemini-cli";
            // Codex CLI: o1, gpt-5-codex*, or any gpt-5* subscription (9router cx/ models).
            else if (row.id === "o1" || (row.id && (row.id.startsWith("gpt-5-codex") || row.id.startsWith("gpt-5"))))
                effectiveProvider = "codex-cli";
            else
                effectiveProvider = row.provider;
        }
    }
    else if (row.type === "API Key") {
        if (row.provider === "anthropic")
            effectiveProvider = "anthropic-api";
        // Dedicated DeepSeek adapter (2026-07-09) — registry row provider is
        // "deepseek-api" directly (see config/llm-config.json), so this branch
        // is mostly a no-op passthrough; kept explicit for readability/audit.
        else if (row.provider === "deepseek-api")
            effectiveProvider = "deepseek-api";
        // openai-compat stays as-is for API Key
    }
    return {
        provider: effectiveProvider,
        model: row.id,
        baseUrl: row.baseUrl,
        apiKeyEnv: row.apiKeyEnv,
        active: row.active !== false,
    };
}
async function check(skill, tier) {
    if (!skill)
        return { allow: false, reason: "no skill" };
    if (!tier)
        return { allow: false, reason: "no tier" };
    let policies;
    try {
        policies = _load();
    }
    catch (_e) {
        return { allow: false, reason: "policies load error" };
    }
    const skillPolicy = policies.skills[skill] || policies.skills["*"] || null;
    if (!skillPolicy)
        return { allow: false, reason: "no policy for skill" };
    const binding = skillPolicy.tiers && skillPolicy.tiers[tier];
    if (!binding)
        return { allow: false, reason: `tier '${tier}' not permitted for skill` };
    // Resolve via modelKey (Notion-synced registry) if provided; otherwise use
    // inline provider+model (legacy). Explicit binding fields always win over
    // resolved ones.
    let resolvedProvider = binding.provider;
    let resolvedModel = binding.model;
    let resolvedBaseUrl = binding.baseUrl;
    let resolvedApiKeyEnv = binding.apiKeyEnv;
    if (binding.modelKey) {
        const resolved = resolveModelKey(binding.modelKey);
        if (!resolved) {
            return { allow: false, reason: `modelKey '${binding.modelKey}' not in llmModels registry` };
        }
        // active=false enforcement only for cost-metered API providers. Anthropic
        // CLI (session subscription) + Anthropic API remain permitted regardless
        // — Nexus Notion row keeps them `active=false` while credits are zero but
        // subscription-tier CLI still runs.
        if (!resolved.active && _isCostMetered(resolved.provider)) {
            return { allow: false, reason: `modelKey '${binding.modelKey}' is inactive in llmModels registry` };
        }
        if (!resolvedProvider)
            resolvedProvider = resolved.provider;
        if (!resolvedModel)
            resolvedModel = resolved.model;
        if (resolvedBaseUrl === undefined && resolved.baseUrl)
            resolvedBaseUrl = resolved.baseUrl;
        if (resolvedApiKeyEnv === undefined && resolved.apiKeyEnv)
            resolvedApiKeyEnv = resolved.apiKeyEnv;
    }
    if (!resolvedProvider || !resolvedModel) {
        return { allow: false, reason: "invalid tier binding" };
    }
    // Proxy-vs-original endpoint resolution + model-id prefix normalization now
    // lives in a single shared layer: lib/proxy-override/. It applies uniformly
    // to every dispatchCall path (tier binding via this engine, modelOverride,
    // env-override) — see commons/ai-gateway/index.ts dispatchCall(). This
    // function only resolves the registry/binding-declared provider+model+
    // baseUrl+apiKeyEnv; proxy routing is layered on top by the caller.
    // Provider-specific binding validation.
    if (resolvedProvider === "openai-compat" ||
        resolvedProvider === "openai-embeddings" ||
        resolvedProvider === "deepseek-api") {
        if (!resolvedBaseUrl || !resolvedApiKeyEnv) {
            return { allow: false, reason: `${resolvedProvider} requires baseUrl + apiKeyEnv in binding` };
        }
    }
    return {
        allow: true,
        provider: resolvedProvider,
        model: resolvedModel,
        baseUrl: resolvedBaseUrl,
        apiKeyEnv: resolvedApiKeyEnv,
        timeoutMs: binding.timeoutMs,
        allowedTools: binding.allowedTools,
        maxOutputTokens: skillPolicy.maxOutputTokens || 4096,
        dailyTokenQuota: skillPolicy.dailyTokenQuota || 200000,
    };
}
// Test helper — reset cached policies + models (used by tests only).
function _reset() {
    _policies = null;
    _models = null;
    _modelsLoadedAt = 0;
}
module.exports = { check, _reset, _modelsSource, resolveModelKey, _isCostMetered };
//# sourceMappingURL=engine.js.map