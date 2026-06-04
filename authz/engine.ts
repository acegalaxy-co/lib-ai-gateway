"use strict";

// ai-gateway/authz/engine.ts
// L2 — Authz: skill + tier → allowed provider+model. Default-deny.
// Mirrors ott-gateway/authz/engine.ts shape (identity→command → skill→tier).

import path = require("path");
import fs = require("fs");

interface TierBinding {
  provider: string;
  model: string;
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
  if (!binding.provider || !binding.model) {
    return { allow: false, reason: "invalid tier binding" };
  }

  // Provider-specific binding validation.
  if (binding.provider === "openai-compat" || binding.provider === "openai-embeddings") {
    if (!binding.baseUrl || !binding.apiKeyEnv) {
      return { allow: false, reason: `${binding.provider} requires baseUrl + apiKeyEnv in binding` };
    }
  }

  return {
    allow: true,
    provider: binding.provider,
    model: binding.model,
    baseUrl: binding.baseUrl,
    apiKeyEnv: binding.apiKeyEnv,
    timeoutMs: binding.timeoutMs,
    allowedTools: binding.allowedTools,
    maxOutputTokens: skillPolicy.maxOutputTokens || 4096,
    dailyTokenQuota: skillPolicy.dailyTokenQuota || 200000,
  };
}

// Test helper — reset cached policies (used by tests only).
function _reset(): void {
  _policies = null;
}

export = { check, _reset };
