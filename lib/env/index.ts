"use strict";

// commons/ai-gateway/lib/env/index.ts
// Single source of truth for runtime-environment detection used across the
// gateway. LOCAL means LLM traffic is routed through the 9router proxy
// (ANTHROPIC_BASE_URL points at 127.0.0.1:20128 / 9router), which requires a
// "cc/" prefix on Anthropic model ids; PROD routes through api.anthropic.com
// with bare ids. Centralized here so engine.ts (model normalization) and
// client.ts (Notion row Env filter) never drift apart on the detection rule.

/** True when the current process routes LLM calls through the local 9router proxy. */
function isLocalEndpoint(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "";
  return /127\.0\.0\.1:20128|9router/.test(baseUrl) || process.env.LOCAL_SERVICE_MODE === "1";
}

/** Runtime env label matching the Notion `Env` select column ("Local" | "Prod"). */
function resolveEnv(): "Local" | "Prod" {
  return isLocalEndpoint() ? "Local" : "Prod";
}

export = { isLocalEndpoint, resolveEnv };
