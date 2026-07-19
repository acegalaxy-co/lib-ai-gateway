"use strict";
// ai-gateway/index.ts
// Entry — dispatchCall(): 5-layer default-deny pipeline. Never throws.
// Mirrors ott-gateway/index.ts::dispatchInbound(). See README + .claude/rules/system-ai-gateway.md.
// Adapters split by billing Type: api-key/ (REST) vs subscription/ (CLI).
const { AnthropicAPIAdapter } = require("./adapters/api-key/anthropic-api");
const { OpenAICompatAdapter } = require("./adapters/api-key/openai-compat");
const { DeepSeekAdapter } = require("./adapters/api-key/deepseek");
const { OpenAIEmbeddingsAdapter } = require("./adapters/api-key/openai-embeddings");
const { AnthropicCLIAdapter } = require("./adapters/subscription/anthropic-cli");
const { GeminiCLIAdapter } = require("./adapters/subscription/gemini-cli");
const { CodexCLIAdapter } = require("./adapters/subscription/codex-cli");
const authz = require("./authz/engine");
const budget = require("./rate-limit/budget");
const breaker = require("./rate-limit/circuit-breaker");
const audit = require("./audit/logger");
const { ClaudeCliLimitError } = require("./lib/claude-limit/error");
const { isLocalEndpoint, resolveEnv } = require("./lib/env");
const { applyProxyOverride } = require("./lib/proxy-override");
const _adapters = new Map();
function _getAdapter(provider) {
    if (_adapters.has(provider))
        return _adapters.get(provider);
    let adapter;
    switch (provider) {
        case "anthropic-api":
            adapter = new AnthropicAPIAdapter();
            break;
        case "openai-compat":
            adapter = new OpenAICompatAdapter();
            break;
        case "deepseek-api":
            adapter = new DeepSeekAdapter();
            break;
        case "anthropic-cli":
            adapter = new AnthropicCLIAdapter();
            break;
        case "gemini-cli":
            adapter = new GeminiCLIAdapter();
            break;
        case "codex-cli":
            adapter = new CodexCLIAdapter();
            break;
        case "openai-embeddings":
            adapter = new OpenAIEmbeddingsAdapter();
            break;
        default:
            return null;
    }
    _adapters.set(provider, adapter);
    return adapter;
}
function _nowIso() {
    return new Date().toISOString();
}
/**
 * Resolve runtime model override from env vars.
 *
 * Priority (high → low):
 *   1. NEXUS_AI_GATEWAY_MODEL_<SKILL_UPPER> (dots + dashes → underscores)
 *   2. NEXUS_AI_GATEWAY_MODEL_DEFAULT
 *
 * Only applies to Anthropic providers (`anthropic-api`, `anthropic-cli`) —
 * cross-provider swap needs baseUrl/apiKeyEnv, which env vars cannot carry
 * safely. Skills bound to `openai-compat` (DeepSeek/Gemini) are left alone.
 *
 * Returns null if no override or provider not Anthropic.
 *
 * Example — bind Haiku to crawler.extract for one run:
 *   NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT=claude-haiku-4-5 npm run start
 *
 * Bind Haiku to all Anthropic skills:
 *   NEXUS_AI_GATEWAY_MODEL_DEFAULT=claude-haiku-4-5
 */
function _resolveEnvModelOverride(skill, provider) {
    if (provider !== "anthropic-api" && provider !== "anthropic-cli")
        return null;
    const skillEnvKey = "NEXUS_AI_GATEWAY_MODEL_" + String(skill).toUpperCase().replace(/[.\-]/g, "_");
    const skillModel = (process.env[skillEnvKey] || "").trim();
    if (skillModel)
        return skillModel;
    const defaultModel = (process.env.NEXUS_AI_GATEWAY_MODEL_DEFAULT || "").trim();
    return defaultModel || null;
}
async function dispatchCall(req) {
    const started = Date.now();
    const outcome = {
        ts: _nowIso(),
        skill: req.skill || "",
        tier: req.tier || "balanced",
        provider: null,
        model: null,
        tokensIn: 0,
        tokensOut: 0,
        outcome: "deny",
        denyReason: null,
        latencyMs: 0,
    };
    const resp = {
        outcome: "deny",
        denyReason: null,
        text: null,
        schemaJson: null,
        provider: null,
        model: null,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        needsToolExecution: false,
        response: null,
    };
    let reservationId = null;
    let provider = null;
    try {
        // L2 — Authz (skill+tier → provider+model). Run before adapter so we know which provider to load.
        let authzResult;
        try {
            authzResult = await authz.check(req.skill, req.tier);
        }
        catch (_e) {
            authzResult = { allow: false, reason: "authz error" };
        }
        if (!authzResult.allow) {
            outcome.denyReason = "L2_authz";
            resp.denyReason = "L2_authz";
            return await _finalize(resp, outcome, started);
        }
        // Apply runtime model override (Phase 4) — caller picks model dynamically.
        // Quota/budget still enforced under the skill, but provider+model swap is allowed.
        if (req.modelOverride && req.modelOverride.provider && req.modelOverride.model) {
            authzResult.provider = req.modelOverride.provider;
            authzResult.model = req.modelOverride.model;
            if (req.modelOverride.baseUrl)
                authzResult.baseUrl = req.modelOverride.baseUrl;
            if (req.modelOverride.apiKeyEnv)
                authzResult.apiKeyEnv = req.modelOverride.apiKeyEnv;
        }
        else {
            // Env-based model override (Anthropic providers only — swapping across
            // providers requires baseUrl/apiKeyEnv which env vars can't reliably
            // carry). Priority: skill-specific > default. Provider/baseUrl/quota
            // stay per-policy. Set NEXUS_AI_GATEWAY_MODEL_<SKILL_UPPER_UNDERSCORE>
            // for one skill (e.g. NEXUS_AI_GATEWAY_MODEL_CRAWLER_EXTRACT) or
            // NEXUS_AI_GATEWAY_MODEL_DEFAULT for all Anthropic skills.
            const envModel = _resolveEnvModelOverride(req.skill, authzResult.provider);
            if (envModel)
                authzResult.model = envModel;
        }
        // Single proxy-override layer — resolve original-vs-proxy endpoint + model
        // prefix for ALL paths (tier-binding, modelOverride, env-override) uniformly.
        // Replaces the per-vendor endpoint/prefix logic previously in authz/engine.ts.
        const _po = applyProxyOverride({
            provider: authzResult.provider,
            model: authzResult.model,
            baseUrl: authzResult.baseUrl,
            apiKeyEnv: authzResult.apiKeyEnv,
        });
        authzResult.model = _po.model;
        authzResult.baseUrl = _po.baseUrl;
        authzResult.apiKeyEnv = _po.apiKeyEnv;
        provider = authzResult.provider;
        outcome.provider = provider;
        outcome.model = authzResult.model;
        resp.provider = provider;
        resp.model = authzResult.model;
        // L1 — Adapter availability (we have a binding, but does the adapter exist + is it usable?).
        const adapter = _getAdapter(provider);
        if (!adapter) {
            outcome.denyReason = "L1_provider_unavailable";
            resp.denyReason = "L1_provider_unavailable";
            return await _finalize(resp, outcome, started);
        }
        // L4 — Circuit breaker (check BEFORE reserving budget so blocked providers don't burn quota).
        const breakerResult = await breaker.guard(provider);
        if (!breakerResult.ok) {
            outcome.denyReason = "L4_circuit_open";
            resp.denyReason = "L4_circuit_open";
            return await _finalize(resp, outcome, started);
        }
        // L3 — Budget reserve (estimate from prompt/messages length + maxOutputTokens cap).
        const maxOut = Math.min(req.maxOutputTokens || authzResult.maxOutputTokens, authzResult.maxOutputTokens);
        // For chat-mode, concat all message content to estimate input tokens.
        let estIn = 0;
        if (Array.isArray(req.messages) && req.messages.length > 0) {
            let buf = req.systemPrompt || "";
            for (const m of req.messages) {
                if (typeof m.content === "string")
                    buf += "\n" + m.content;
                else if (Array.isArray(m.content)) {
                    for (const b of m.content) {
                        const text = b.text || b.content || "";
                        if (typeof text === "string")
                            buf += "\n" + text;
                    }
                }
            }
            estIn = adapter.estimateTokens(buf);
        }
        else {
            estIn = adapter.estimateTokens(req.prompt || "");
        }
        const estimatedTotal = estIn + maxOut;
        const reserveResult = await budget.reserve(req.skill, estimatedTotal, authzResult.dailyTokenQuota);
        if (!reserveResult.ok) {
            outcome.denyReason = "L3_budget_exhausted";
            resp.denyReason = "L3_budget_exhausted";
            return await _finalize(resp, outcome, started);
        }
        reservationId = reserveResult.reservationId;
        // All gates passed → invoke adapter.
        let adapterResp;
        try {
            adapterResp = await adapter.complete({
                skill: req.skill,
                prompt: req.prompt,
                messages: req.messages,
                systemPrompt: req.systemPrompt,
                systemPromptCacheable: req.systemPromptCacheable,
                tools: req.tools,
                onDelta: req.onDelta,
                model: authzResult.model,
                maxOutputTokens: maxOut,
                schema: req.schema || null,
                baseUrl: authzResult.baseUrl,
                apiKeyEnv: authzResult.apiKeyEnv,
                timeoutMs: authzResult.timeoutMs,
                allowedTools: authzResult.allowedTools,
                // MCP config — prefer per-call override, else fall back to policy binding
                mcpConfigPath: req.mcpConfigPath || authzResult.mcpConfigPath,
            });
            breaker.recordSuccess(provider);
        }
        catch (err) {
            // Check for limit error first (don't treat as circuit failure)
            if (err instanceof ClaudeCliLimitError) {
                breaker.recordSuccess(provider); // Limit is transient, not provider failure
                if (reservationId)
                    await budget.refund(reservationId);
                reservationId = null;
                outcome.denyReason = "L4_circuit_open"; // Semantic: rate-limited
                resp.denyReason = "L4_circuit_open";
                // eslint-disable-next-line no-console
                console.error("[ai-gateway][claude-cli-limit]", err && err.message);
                return await _finalize(resp, outcome, started);
            }
            // Generic adapter error — treat as provider failure
            breaker.recordFailure(provider);
            // Refund reservation since call never billed.
            if (reservationId)
                await budget.refund(reservationId);
            reservationId = null;
            // eslint-disable-next-line no-console
            console.error("[ai-gateway] adapter.complete failed:", err && err.message);
            outcome.denyReason = "L1_provider_unavailable";
            resp.denyReason = "L1_provider_unavailable";
            return await _finalize(resp, outcome, started);
        }
        // Commit actual tokens.
        const actualTotal = (adapterResp.tokensIn || 0) + (adapterResp.tokensOut || 0);
        if (reservationId) {
            await budget.commit(reservationId, actualTotal);
            reservationId = null;
        }
        // Extract cache stats if adapter provided them (Anthropic prompt cache)
        if (adapterResp.cachedTokensIn != null) {
            outcome.cachedTokensIn = adapterResp.cachedTokensIn;
        }
        if (adapterResp.cacheCreationIn != null) {
            outcome.cacheCreationIn = adapterResp.cacheCreationIn;
        }
        outcome.outcome = "allow";
        outcome.denyReason = null;
        outcome.tokensIn = adapterResp.tokensIn || 0;
        outcome.tokensOut = adapterResp.tokensOut || 0;
        resp.outcome = "allow";
        resp.denyReason = null;
        resp.text = adapterResp.text;
        resp.schemaJson = adapterResp.schemaJson;
        resp.tokensIn = adapterResp.tokensIn || 0;
        resp.tokensOut = adapterResp.tokensOut || 0;
        // Chat-mode passthrough.
        if (adapterResp.needsToolExecution !== undefined) {
            resp.needsToolExecution = adapterResp.needsToolExecution;
        }
        if (adapterResp.response !== undefined) {
            resp.response = adapterResp.response;
        }
        return await _finalize(resp, outcome, started);
    }
    catch (err) {
        // Top-level safety net.
        // eslint-disable-next-line no-console
        console.error("[ai-gateway] dispatchCall fatal:", err && err.message);
        if (reservationId) {
            try {
                await budget.refund(reservationId);
            }
            catch (_e) { /* swallow */ }
        }
        outcome.denyReason = outcome.denyReason || "L1_provider_unavailable";
        resp.denyReason = resp.denyReason || "L1_provider_unavailable";
        return await _finalize(resp, outcome, started);
    }
}
async function _finalize(resp, outcome, started) {
    outcome.latencyMs = Date.now() - started;
    resp.latencyMs = outcome.latencyMs;
    try {
        await audit.record(outcome);
    }
    catch (_e) {
        // audit.record already swallows; double-guard.
    }
    return resp;
}
async function dispatchEmbed(req) {
    const started = Date.now();
    const outcome = {
        ts: _nowIso(),
        skill: req.skill || "",
        tier: req.tier || "balanced",
        provider: null,
        model: null,
        tokensIn: 0,
        tokensOut: 0,
        outcome: "deny",
        denyReason: null,
        latencyMs: 0,
    };
    const resp = {
        outcome: "deny",
        denyReason: null,
        vectors: null,
        provider: null,
        model: null,
        tokensIn: 0,
        latencyMs: 0,
    };
    let reservationId = null;
    let provider = null;
    try {
        // L2 — Authz
        let authzResult;
        try {
            authzResult = await authz.check(req.skill, req.tier);
        }
        catch (_e) {
            authzResult = { allow: false, reason: "authz error" };
        }
        if (!authzResult.allow) {
            outcome.denyReason = "L2_authz";
            resp.denyReason = "L2_authz";
            return await _finalizeEmbed(resp, outcome, started);
        }
        provider = authzResult.provider;
        outcome.provider = provider;
        outcome.model = authzResult.model;
        resp.provider = provider;
        resp.model = authzResult.model;
        // L1 — Adapter
        const adapter = _getAdapter(provider);
        if (!adapter || typeof adapter.embed !== "function") {
            outcome.denyReason = "L1_provider_unavailable";
            resp.denyReason = "L1_provider_unavailable";
            return await _finalizeEmbed(resp, outcome, started);
        }
        // L4 — Circuit breaker
        const breakerResult = await breaker.guard(provider);
        if (!breakerResult.ok) {
            outcome.denyReason = "L4_circuit_open";
            resp.denyReason = "L4_circuit_open";
            return await _finalizeEmbed(resp, outcome, started);
        }
        // L3 — Budget reserve (embed has no output tokens; estimate input only).
        const estIn = adapter.estimateTokens(req.inputs || []);
        const reserveResult = await budget.reserve(req.skill, estIn, authzResult.dailyTokenQuota);
        if (!reserveResult.ok) {
            outcome.denyReason = "L3_budget_exhausted";
            resp.denyReason = "L3_budget_exhausted";
            return await _finalizeEmbed(resp, outcome, started);
        }
        reservationId = reserveResult.reservationId;
        let adapterResp;
        try {
            adapterResp = await adapter.embed({
                inputs: req.inputs,
                model: authzResult.model,
                baseUrl: authzResult.baseUrl,
                apiKeyEnv: authzResult.apiKeyEnv,
            });
            breaker.recordSuccess(provider);
        }
        catch (err) {
            breaker.recordFailure(provider);
            if (reservationId)
                await budget.refund(reservationId);
            reservationId = null;
            // eslint-disable-next-line no-console
            console.error("[ai-gateway] adapter.embed failed:", err && err.message);
            outcome.denyReason = "L1_provider_unavailable";
            resp.denyReason = "L1_provider_unavailable";
            return await _finalizeEmbed(resp, outcome, started);
        }
        if (reservationId) {
            await budget.commit(reservationId, adapterResp.tokensIn || 0);
            reservationId = null;
        }
        // Extract cache stats if adapter provided them (Anthropic prompt cache)
        if (adapterResp.cachedTokensIn != null) {
            outcome.cachedTokensIn = adapterResp.cachedTokensIn;
        }
        if (adapterResp.cacheCreationIn != null) {
            outcome.cacheCreationIn = adapterResp.cacheCreationIn;
        }
        outcome.outcome = "allow";
        outcome.denyReason = null;
        outcome.tokensIn = adapterResp.tokensIn || 0;
        outcome.tokensOut = 0;
        resp.outcome = "allow";
        resp.denyReason = null;
        resp.vectors = adapterResp.vectors || null;
        resp.tokensIn = adapterResp.tokensIn || 0;
        return await _finalizeEmbed(resp, outcome, started);
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.error("[ai-gateway] dispatchEmbed fatal:", err && err.message);
        if (reservationId) {
            try {
                await budget.refund(reservationId);
            }
            catch (_e) { /* swallow */ }
        }
        outcome.denyReason = outcome.denyReason || "L1_provider_unavailable";
        resp.denyReason = resp.denyReason || "L1_provider_unavailable";
        return await _finalizeEmbed(resp, outcome, started);
    }
}
async function _finalizeEmbed(resp, outcome, started) {
    outcome.latencyMs = Date.now() - started;
    resp.latencyMs = outcome.latencyMs;
    try {
        await audit.record(outcome);
    }
    catch (_e) { /* swallow */ }
    return resp;
}
module.exports = { dispatchCall, dispatchEmbed, isLocalEndpoint, resolveEnv };
//# sourceMappingURL=index.js.map