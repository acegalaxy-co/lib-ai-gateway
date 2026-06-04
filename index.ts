"use strict";

// ai-gateway/index.ts
// Entry — dispatchCall(): 5-layer default-deny pipeline. Never throws.
// Mirrors ott-gateway/index.ts::dispatchInbound(). See README + .claude/rules/system-ai-gateway.md.

const { AnthropicAPIAdapter } = require("./adapters/anthropic-api");
const { OpenAICompatAdapter } = require("./adapters/openai-compat");
const { AnthropicCLIAdapter } = require("./adapters/anthropic-cli");
const { OpenAIEmbeddingsAdapter } = require("./adapters/openai-embeddings");
const authz = require("./authz/engine");
const budget = require("./rate-limit/budget");
const breaker = require("./rate-limit/circuit-breaker");
const audit = require("./audit/logger");

type Tier = "fast" | "balanced" | "deep";
type DenyReason =
  | "L1_provider_unavailable"
  | "L2_authz"
  | "L3_budget_exhausted"
  | "L4_circuit_open"
  | "L5_audit_fatal";

interface AICallRequest {
  skill: string;
  tier: Tier;
  prompt: string;
  schema?: Record<string, unknown> | null;
  maxOutputTokens?: number;
  metadata?: Record<string, unknown>;
}

interface AICallResponse {
  outcome: "allow" | "deny";
  denyReason: DenyReason | null;
  text: string | null;
  schemaJson: unknown | null;
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

interface OutcomeRecord {
  ts: string;
  skill: string;
  tier: Tier;
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  outcome: "allow" | "deny";
  denyReason: DenyReason | null;
  latencyMs: number;
}

const _adapters: Map<string, any> = new Map();

function _getAdapter(provider: string): any {
  if (_adapters.has(provider)) return _adapters.get(provider);
  let adapter: any;
  switch (provider) {
    case "anthropic-api":
      adapter = new AnthropicAPIAdapter();
      break;
    case "openai-compat":
      adapter = new OpenAICompatAdapter();
      break;
    case "anthropic-cli":
      adapter = new AnthropicCLIAdapter();
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

function _nowIso(): string {
  return new Date().toISOString();
}

async function dispatchCall(req: AICallRequest): Promise<AICallResponse> {
  const started = Date.now();

  const outcome: OutcomeRecord = {
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

  const resp: AICallResponse = {
    outcome: "deny",
    denyReason: null,
    text: null,
    schemaJson: null,
    provider: null,
    model: null,
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: 0,
  };

  let reservationId: string | null = null;
  let provider: string | null = null;

  try {
    // L2 — Authz (skill+tier → provider+model). Run before adapter so we know which provider to load.
    let authzResult: any;
    try {
      authzResult = await authz.check(req.skill, req.tier);
    } catch (_e) {
      authzResult = { allow: false, reason: "authz error" };
    }
    if (!authzResult.allow) {
      outcome.denyReason = "L2_authz";
      resp.denyReason = "L2_authz";
      return await _finalize(resp, outcome, started);
    }
    provider = authzResult.provider;
    outcome.provider = provider;
    outcome.model = authzResult.model;
    resp.provider = provider;
    resp.model = authzResult.model;

    // L1 — Adapter availability (we have a binding, but does the adapter exist + is it usable?).
    const adapter = _getAdapter(provider as string);
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

    // L3 — Budget reserve (estimate from prompt length + maxOutputTokens cap).
    const maxOut = Math.min(
      req.maxOutputTokens || authzResult.maxOutputTokens,
      authzResult.maxOutputTokens
    );
    const estIn = adapter.estimateTokens(req.prompt || "");
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
        prompt: req.prompt,
        model: authzResult.model,
        maxOutputTokens: maxOut,
        schema: req.schema || null,
        baseUrl: authzResult.baseUrl,
        apiKeyEnv: authzResult.apiKeyEnv,
        timeoutMs: authzResult.timeoutMs,
        allowedTools: authzResult.allowedTools,
      });
      breaker.recordSuccess(provider);
    } catch (err: unknown) {
      breaker.recordFailure(provider as string);
      // Refund reservation since call never billed.
      if (reservationId) await budget.refund(reservationId);
      reservationId = null;
      // eslint-disable-next-line no-console
      console.error("[ai-gateway] adapter.complete failed:", err && (err as Error).message);
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

    return await _finalize(resp, outcome, started);
  } catch (err: unknown) {
    // Top-level safety net.
    // eslint-disable-next-line no-console
    console.error("[ai-gateway] dispatchCall fatal:", err && (err as Error).message);
    if (reservationId) {
      try { await budget.refund(reservationId); } catch (_e) { /* swallow */ }
    }
    outcome.denyReason = outcome.denyReason || "L1_provider_unavailable";
    resp.denyReason = resp.denyReason || "L1_provider_unavailable";
    return await _finalize(resp, outcome, started);
  }
}

async function _finalize(
  resp: AICallResponse,
  outcome: OutcomeRecord,
  started: number
): Promise<AICallResponse> {
  outcome.latencyMs = Date.now() - started;
  resp.latencyMs = outcome.latencyMs;
  try {
    await audit.record(outcome);
  } catch (_e) {
    // audit.record already swallows; double-guard.
  }
  return resp;
}

// ══════════════════════════════════════════════════════════════════════
// dispatchEmbed — parallel pipeline for embedding adapters.
// Same 5-layer skeleton as dispatchCall; only differs in adapter method.
// ══════════════════════════════════════════════════════════════════════

interface AIEmbedRequest {
  skill: string;
  tier: Tier;
  inputs: string[];
  metadata?: Record<string, unknown>;
}

interface AIEmbedResponse {
  outcome: "allow" | "deny";
  denyReason: DenyReason | null;
  vectors: number[][] | null;
  provider: string | null;
  model: string | null;
  tokensIn: number;
  latencyMs: number;
}

async function dispatchEmbed(req: AIEmbedRequest): Promise<AIEmbedResponse> {
  const started = Date.now();

  const outcome: OutcomeRecord = {
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

  const resp: AIEmbedResponse = {
    outcome: "deny",
    denyReason: null,
    vectors: null,
    provider: null,
    model: null,
    tokensIn: 0,
    latencyMs: 0,
  };

  let reservationId: string | null = null;
  let provider: string | null = null;

  try {
    // L2 — Authz
    let authzResult: any;
    try {
      authzResult = await authz.check(req.skill, req.tier);
    } catch (_e) {
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
    const adapter = _getAdapter(provider as string);
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
    } catch (err: unknown) {
      breaker.recordFailure(provider as string);
      if (reservationId) await budget.refund(reservationId);
      reservationId = null;
      // eslint-disable-next-line no-console
      console.error("[ai-gateway] adapter.embed failed:", err && (err as Error).message);
      outcome.denyReason = "L1_provider_unavailable";
      resp.denyReason = "L1_provider_unavailable";
      return await _finalizeEmbed(resp, outcome, started);
    }

    if (reservationId) {
      await budget.commit(reservationId, adapterResp.tokensIn || 0);
      reservationId = null;
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
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.error("[ai-gateway] dispatchEmbed fatal:", err && (err as Error).message);
    if (reservationId) {
      try { await budget.refund(reservationId); } catch (_e) { /* swallow */ }
    }
    outcome.denyReason = outcome.denyReason || "L1_provider_unavailable";
    resp.denyReason = resp.denyReason || "L1_provider_unavailable";
    return await _finalizeEmbed(resp, outcome, started);
  }
}

async function _finalizeEmbed(
  resp: AIEmbedResponse,
  outcome: OutcomeRecord,
  started: number
): Promise<AIEmbedResponse> {
  outcome.latencyMs = Date.now() - started;
  resp.latencyMs = outcome.latencyMs;
  try { await audit.record(outcome); } catch (_e) { /* swallow */ }
  return resp;
}

export = { dispatchCall, dispatchEmbed };
