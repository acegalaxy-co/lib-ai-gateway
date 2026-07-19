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
//
// Config-driven (2026-07-19): family/prefix/host/env-name knobs moved to
// config/proxy.json (values = original hardcode) with .env override,
// mirroring authz/engine.ts _load()/_repoRoot()/AI_GATEWAY_CONFIG_ROOT
// pattern. Any load/parse failure falls back to DEFAULT_CONFIG so the
// gateway never throws.
const path = require("path");
const fs = require("fs");
// Defaults mirror the config/proxy.json committed alongside this file —
// used only when the file is missing/unreadable/malformed at runtime.
const DEFAULT_CONFIG = {
    proxy: { baseUrlEnv: "NEXUS_9ROUTER_BASE_URL", tokenEnv: "NEXUS_9ROUTER_TOKEN", hostPattern: "9router" },
    families: {
        anthropic: {
            prefix: "cc/",
            originalHosts: ["api.anthropic.com"],
            match: { providerPrefix: "anthropic", modelPrefix: "claude" },
            baseUrlEnv: ["NEXUS_CLAUDE_BASE_URL", "ANTHROPIC_BASE_URL"],
            proxyEnableEnv: null,
            switchTokenOnProxyHost: false,
        },
        deepseek: {
            prefix: "ds/",
            originalHosts: ["api.deepseek.com"],
            match: { provider: "deepseek-api", modelPrefix: "deepseek" },
            baseUrlEnv: ["NEXUS_DEEPSEEK_BASE_URL"],
            proxyEnableEnv: "NEXUS_9ROUTER_RUNTIME_DEEPSEEK_API_ENABLE",
            switchTokenOnProxyHost: true,
        },
        codex: {
            prefix: "cx/",
            originalHosts: ["api.openai.com"],
            match: { provider: "codex-cli" },
            baseUrlEnv: ["NEXUS_CODEX_BASE_URL"],
            proxyEnableEnv: "NEXUS_9ROUTER_RUNTIME_OPENAI_CLI_ENABLE",
            switchTokenOnProxyHost: false,
        },
    },
    localDetect: { baseUrlEnv: "ANTHROPIC_BASE_URL", forceLocalEnv: "LOCAL_SERVICE_MODE" },
};
let _config = null;
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
    return path.resolve(__dirname, "..", "..");
}
// Test helper — force reload after mutating env / fixture file.
function _resetConfigCache() {
    _config = null;
}
function _loadProxyConfig() {
    if (_config)
        return _config;
    const candidates = [];
    const explicit = process.env.AI_GATEWAY_PROXY_CONFIG;
    if (explicit)
        candidates.push(explicit);
    const configRoot = process.env.AI_GATEWAY_CONFIG_ROOT;
    if (configRoot)
        candidates.push(path.join(configRoot, "config", "proxy.json"));
    // Co-located (works in dist tree after copy-assets, and in source tree).
    candidates.push(path.join(__dirname, "..", "..", "config", "proxy.json"));
    candidates.push(path.join(_packageRoot(), "config", "proxy.json"));
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
                if (raw && raw.families) {
                    _config = raw;
                    return _config;
                }
            }
        }
        catch (_e) {
            // try next candidate
        }
    }
    _config = DEFAULT_CONFIG;
    return _config;
}
function _bool(v) {
    const t = (v || "").trim().toLowerCase();
    return t === "1" || t === "true";
}
function _family(config, provider, bareModel) {
    const p = provider || "";
    for (const key of Object.keys(config.families)) {
        const m = config.families[key].match;
        if (m.provider && p === m.provider)
            return key;
        if (m.providerPrefix && p.indexOf(m.providerPrefix) === 0)
            return key;
        if (m.modelPrefix && bareModel.startsWith(m.modelPrefix))
            return key;
    }
    return null;
}
function _prefixRe(config) {
    const prefixes = Object.keys(config.families).map((k) => config.families[k].prefix.replace(/\//g, "\\/"));
    return new RegExp(`^(${prefixes.join("|")})`);
}
function applyProxyOverride(input) {
    const config = _loadProxyConfig();
    const originalModel = input.model;
    const bareModel = originalModel.replace(_prefixRe(config), "");
    const familyKey = _family(config, input.provider, bareModel);
    if (!familyKey) {
        // Non-family provider (gemini-cli, openai-embeddings, ...) — untouched,
        // including the ORIGINAL (unstripped) model string.
        return { model: originalModel, baseUrl: input.baseUrl, apiKeyEnv: input.apiKeyEnv };
    }
    const family = config.families[familyKey];
    let baseUrl = input.baseUrl;
    let apiKeyEnv = input.apiKeyEnv;
    let endpoint = "";
    for (const envName of family.baseUrlEnv) {
        const v = (process.env[envName] || "").trim();
        if (v) {
            endpoint = v;
            break;
        }
    }
    if (family.proxyEnableEnv && _bool(process.env[family.proxyEnableEnv])) {
        baseUrl = process.env[config.proxy.baseUrlEnv];
        apiKeyEnv = config.proxy.tokenEnv;
    }
    else if (endpoint) {
        baseUrl = endpoint;
        if (family.switchTokenOnProxyHost && baseUrl.indexOf(config.proxy.hostPattern) !== -1) {
            apiKeyEnv = config.proxy.tokenEnv;
        }
    }
    const resolved = (baseUrl || "").trim();
    const isOriginal = !resolved || family.originalHosts.some((h) => resolved.includes(h));
    const model = isOriginal ? bareModel : family.prefix + bareModel;
    return { model, baseUrl, apiKeyEnv };
}
module.exports = { applyProxyOverride, _resetConfigCache, _loadProxyConfig };
//# sourceMappingURL=index.js.map