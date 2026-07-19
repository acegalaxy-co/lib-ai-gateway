"use strict";
// commons/ai-gateway/lib/env/index.ts
// Single source of truth for runtime-environment detection used across the
// gateway. LOCAL means LLM traffic is routed through the 9router proxy
// (ANTHROPIC_BASE_URL points at 9router), which requires a
// "cc/" prefix on Anthropic model ids; PROD routes through api.anthropic.com
// with bare ids. Centralized here so engine.ts (model normalization) and
// client.ts (Notion row Env filter) never drift apart on the detection rule.
//
// Config-driven (2026-07-19): host pattern + env var names read from
// config/proxy.json `localDetect` (same loader as lib/proxy-override, to
// avoid drift). On load failure falls back to the original hardcode.
const proxyOverride = require("../proxy-override");
/** True when the current process routes LLM calls through the local 9router proxy. */
function isLocalEndpoint() {
    let config;
    try {
        config = proxyOverride._loadProxyConfig();
    }
    catch (_e) {
        config = null;
    }
    const baseUrlEnv = (config && config.localDetect && config.localDetect.baseUrlEnv) || "ANTHROPIC_BASE_URL";
    const forceLocalEnv = (config && config.localDetect && config.localDetect.forceLocalEnv) || "LOCAL_SERVICE_MODE";
    const hostPattern = (config && config.proxy && config.proxy.hostPattern) || "9router";
    const baseUrl = process.env[baseUrlEnv] || "";
    return new RegExp(hostPattern).test(baseUrl) || process.env[forceLocalEnv] === "1";
}
/** Runtime env label matching the Notion `Env` select column ("Local" | "Prod"). */
function resolveEnv() {
    return isLocalEndpoint() ? "Local" : "Prod";
}
module.exports = { isLocalEndpoint, resolveEnv };
//# sourceMappingURL=index.js.map