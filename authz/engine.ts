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

import path = require("path");
import fs = require("fs");

interface TierBinding {
  // New (preferred): reference a row in llmModels registry.
  modelKey?: string;
  // Legacy: inline provider+model. Still supported for skills bound to models
  // that aren't in the llmModels registry (e.g. opus not yet catalogued).
  provider?: string;
  model?: string;
  // Optional provider-specific extras (passed verbatim into adapter.complete).
  // - openai-compat / openai-embeddings: baseUrl + apiKeyEnv required
  // - anthropic-api: none (key from ANTHROPIC_API_KEY/NEXUS_ANTHROPIC_API_KEY)
  // - anthropic-cli: timeoutMs?, allowedTools? (CSV)
  baseUrl?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  allowedTools?: string;
}

interface SkillPolicy {
  tiers: Record<string, TierBinding>;
  maxOutputTokens: number;
  dailyTokenQuota: number;
}

interface PoliciesFile {
  skills: Record<string, SkillPolicy>;
}

interface ModelRow {
  id: string;
  provider: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  active?: boolean;
}

interface ModelsFile {
  models: Record<string, ModelRow>;
}

interface CheckResult {
  allow: boolean;
  reason?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  allowedTools?: string;
  maxOutputTokens?: number;
  dailyTokenQuota?: number;
}

let _policies: PoliciesFile | null = null;
let _models: Record<string, ModelRow> | null = null;
let _modelsLoadedAt = 0;
const MODELS_TTL_MS = 5 * 60 * 1000;

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

// Walk up from __dirname until we find a directory containing a top-level
// `config/llm-config.json` or `data/llm-models-cache.json`. Tests can override
// via env AI_GATEWAY_CONFIG_ROOT to point at a fixture directory.
function _repoRoot(): string {
  const override = process.env.AI_GATEWAY_CONFIG_ROOT;
  if (override && fs.existsSync(override)) return override;
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, "config", "llm-config.json"))) return dir;
    if (fs.existsSync(path.join(dir, "data", "llm-models-cache.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "..", "..", "..");
}

function _load(): PoliciesFile {
  if (_policies) return _policies;
  // Prefer co-located policies.json (works in both source & dist tree after copy-assets);
  // fall back to source path under package root if not co-located.
  const here = path.join(__dirname, "policies.json");
  const root = path.join(_packageRoot(), "authz", "policies.json");
  const target = fs.existsSync(here) ? here : root;
  _policies = require(target) as PoliciesFile;
  return _policies;
}

function _loadModels(): Record<string, ModelRow> {
  const now = Date.now();
  if (_models && now - _modelsLoadedAt < MODELS_TTL_MS) return _models;
  const repo = _repoRoot();
  // Layer 1: Notion-synced cache (written by src/app/llm/client.ts every 5min).
  const cachePath = path.join(repo, "data", "llm-models-cache.json");
  // Layer 2: repo-committed fallback.
  const configPath = path.join(repo, "config", "llm-config.json");
  let raw: any = null;
  try {
    if (fs.existsSync(cachePath)) {
      raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    }
  } catch (_e) {
    raw = null;
  }
  if (!raw || !raw.models || Object.keys(raw.models).length === 0) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (_e) {
      raw = { models: {} };
    }
  }
  _models = (raw && raw.models) || {};
  _modelsLoadedAt = now;
  return _models as Record<string, ModelRow>;
}

// Test helper — return active layer name (used by tests only).
function _modelsSource(): "cache" | "config" | "empty" {
  const repo = _repoRoot();
  const cachePath = path.join(repo, "data", "llm-models-cache.json");
  const configPath = path.join(repo, "config", "llm-config.json");
  try {
    if (fs.existsSync(cachePath)) {
      const j = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (j && j.models && Object.keys(j.models).length > 0) return "cache";
    }
  } catch (_e) { /* fall through */ }
  try {
    if (fs.existsSync(configPath)) return "config";
  } catch (_e) { /* fall through */ }
  return "empty";
}

async function check(skill: string, tier: string): Promise<CheckResult> {
  if (!skill) return { allow: false, reason: "no skill" };
  if (!tier) return { allow: false, reason: "no tier" };

  let policies: PoliciesFile;
  try {
    policies = _load();
  } catch (_e: unknown) {
    return { allow: false, reason: "policies load error" };
  }

  const skillPolicy = policies.skills[skill] || policies.skills["*"] || null;
  if (!skillPolicy) return { allow: false, reason: "no policy for skill" };

  const binding = skillPolicy.tiers && skillPolicy.tiers[tier];
  if (!binding) return { allow: false, reason: `tier '${tier}' not permitted for skill` };

  // Resolve via modelKey (Notion-synced registry) if provided; otherwise use
  // inline provider+model (legacy). Explicit binding fields always win over
  // resolved ones.
  let resolvedProvider = binding.provider;
  let resolvedModel = binding.model;
  let resolvedBaseUrl = binding.baseUrl;
  let resolvedApiKeyEnv = binding.apiKeyEnv;

  if (binding.modelKey) {
    const registry = _loadModels();
    const row = registry[binding.modelKey];
    if (!row || !row.id) {
      return { allow: false, reason: `modelKey '${binding.modelKey}' not in llmModels registry` };
    }
    // active=false enforcement only for cost-metered API providers. Anthropic
    // CLI (session subscription) + Anthropic API remain permitted regardless
    // — Nexus Notion row keeps them `active=false` while credits are zero but
    // subscription-tier CLI still runs.
    if (row.active === false && (row.provider === "openai-compat" || row.provider === "openai-embeddings")) {
      return { allow: false, reason: `modelKey '${binding.modelKey}' is inactive in llmModels registry` };
    }
    if (!resolvedProvider) resolvedProvider = row.provider;
    if (!resolvedModel) resolvedModel = row.id;
    if (resolvedBaseUrl === undefined && row.baseUrl) resolvedBaseUrl = row.baseUrl;
    if (resolvedApiKeyEnv === undefined && row.apiKeyEnv) resolvedApiKeyEnv = row.apiKeyEnv;
  }

  if (!resolvedProvider || !resolvedModel) {
    return { allow: false, reason: "invalid tier binding" };
  }

  // Provider-specific binding validation.
  if (resolvedProvider === "openai-compat" || resolvedProvider === "openai-embeddings") {
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
function _reset(): void {
  _policies = null;
  _models = null;
  _modelsLoadedAt = 0;
}

export = { check, _reset, _modelsSource };
