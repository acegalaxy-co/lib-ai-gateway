"use strict";

// commons/ai-gateway/lib/proxy-override/index.ts
// ai-gateway: proxy-override single layer (replaces engine.ts vendor-endpoint + prefix blocks)
//
// Single place to resolve "original API vs proxy (9router)" endpoint +
// model-id prefix for ALL dispatchCall paths (tier binding, modelOverride,
// env-override) uniformly. Previously this logic was duplicated across
// authz/engine.ts (vendor endpoint resolution + 3 separate model-prefix
// blocks) and NEVER applied to the modelOverride path used by
// src/app/llm/client.ts — that gap caused PROD `L1_provider_unavailable`
// (DeepSeek modelOverride bypassed 9router routing entirely).
//
// Detection is whitelist-original-host based (not "does baseUrl contain
// 9router"), so it also covers alternate proxy hosts (9router2, ...).

interface ProxyOverrideInput {
  provider?: string;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

interface ProxyOverrideResult {
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

type Family = "anthropic" | "deepseek" | "codex";

const PREFIX_RE = /^(cc|ds|cx)\//;
const PREFIX: Record<Family, string> = { anthropic: "cc/", deepseek: "ds/", codex: "cx/" };
const ORIGINAL_HOSTS: Record<Family, string[]> = {
  anthropic: ["api.anthropic.com"],
  deepseek: ["api.deepseek.com"],
  codex: ["api.openai.com"],
};

function _bool(v: string | undefined): boolean {
  const t = (v || "").trim().toLowerCase();
  return t === "1" || t === "true";
}

function _family(provider: string | undefined, bareModel: string): Family | null {
  const p = provider || "";
  if (p.indexOf("anthropic") === 0 || bareModel.startsWith("claude")) return "anthropic";
  if (p === "deepseek-api" || bareModel.startsWith("deepseek")) return "deepseek";
  if (p === "codex-cli") return "codex";
  return null;
}

function applyProxyOverride(input: ProxyOverrideInput): ProxyOverrideResult {
  const originalModel = input.model;
  const bareModel = originalModel.replace(PREFIX_RE, "");

  const family = _family(input.provider, bareModel);
  if (!family) {
    // Non-family provider (gemini-cli, openai-embeddings, ...) — untouched,
    // including the ORIGINAL (unstripped) model string.
    return { model: originalModel, baseUrl: input.baseUrl, apiKeyEnv: input.apiKeyEnv };
  }

  let baseUrl = input.baseUrl;
  let apiKeyEnv = input.apiKeyEnv;

  if (family === "anthropic") {
    const ep = (process.env.NEXUS_CLAUDE_BASE_URL || process.env.ANTHROPIC_BASE_URL || "").trim();
    if (ep) baseUrl = ep;
  } else if (family === "deepseek") {
    if (_bool(process.env.NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE)) {
      baseUrl = process.env.NEXUS_9ROUTER_BASE_URL;
      apiKeyEnv = "NEXUS_9ROUTER_TOKEN";
    } else {
      const ep = (process.env.NEXUS_DEEPSEEK_BASE_URL || "").trim();
      if (ep) {
        baseUrl = ep;
        if (baseUrl.indexOf("9router") !== -1) apiKeyEnv = "NEXUS_9ROUTER_TOKEN";
      }
    }
  } else if (family === "codex") {
    if (_bool(process.env.NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE)) {
      baseUrl = process.env.NEXUS_9ROUTER_BASE_URL;
      apiKeyEnv = "NEXUS_9ROUTER_TOKEN";
    } else {
      const ep = (process.env.NEXUS_CODEX_BASE_URL || "").trim();
      if (ep) baseUrl = ep;
    }
  }

  const resolved = (baseUrl || "").trim();
  const isOriginal = !resolved || ORIGINAL_HOSTS[family].some((h) => resolved.includes(h));
  const model = isOriginal ? bareModel : PREFIX[family] + bareModel;

  return { model, baseUrl, apiKeyEnv };
}

export = { applyProxyOverride };
