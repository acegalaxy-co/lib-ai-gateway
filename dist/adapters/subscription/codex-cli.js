"use strict";
// ai-gateway/adapters/codex-cli.ts
// Phase 3b adapter — Codex CLI subprocess for hard reasoning/algo/security tasks.
// Uses OpenAI Codex (ChatGPT Plus subscription via `codex` CLI), no API key.
// No streaming, no tool_use in this phase.
//
// Token usage: CLI does not return per-call token counts. We estimate from
// prompt + output length so budget guard still gets a signal.
//
// Limit handling: codex CLI may throttle on ChatGPT Plus quota exhaustion.
// Parse stderr reactively for rate_limit / auth_error patterns.
const { spawn } = require("child_process");
const { IAIAdapter } = require("../adapter-interface");
const DEFAULT_TIMEOUT_MS = 90_000;
// 9router base_url is resolved by authz/engine.ts and injected as req.baseUrl
// (2026-07-10). PROD (unset) leaves the provider endpoint to codex's own
// config (api.openai.com).
const CODEX_PROVIDER_KEY = "9router"; // matches [model_providers.9router] in ~/.codex/config.toml
function _cliBin() {
    return (process.env.CODEX_CLI_BIN || "").trim() || "codex";
}
function _cliInvocation() {
    const bin = _cliBin();
    // codex CLI may be a script or binary; if .js then wrap with node.
    if (bin.endsWith(".js"))
        return ["node", [bin]];
    return [bin, []];
}
class CodexCLIAdapter extends IAIAdapter {
    get provider() {
        return "codex-cli";
    }
    async complete(req) {
        const timeout = req.timeoutMs || DEFAULT_TIMEOUT_MS;
        const skill = req.skill || "unknown";
        // Strip null bytes — spawn() rejects null in argv/stdin. PDF text may contain \x00.
        const cleanPrompt = String(req.prompt).replace(/\x00/g, "");
        const text = await new Promise((resolve, reject) => {
            const [cmd, prefix] = _cliInvocation();
            const argv = [...prefix, "exec", "-s", "read-only"];
            // Model — pass explicit if policy or env override resolved a value.
            // Skip if empty so CLI keeps its default.
            const modelArg = String(req.model || "").trim();
            if (modelArg)
                argv.push("-m", modelArg);
            // Endpoint switch (2026-07-10): req.baseUrl is resolved by authz/engine.ts
            // from NEXUS_CODEX_BASE_URL. Empty/unset → leave codex's own provider
            // config untouched (direct api.openai.com). Non-empty → override the
            // codex provider's base_url via `-c` so we don't depend on a static
            // ~/.codex/config.toml.
            const _endpoint = String(req.baseUrl || "").trim();
            if (_endpoint) {
                argv.push("-c", `model_providers.${CODEX_PROVIDER_KEY}.base_url="${_endpoint}"`);
            }
            // MCP config — if skill uses MCP tools (e.g., CloakBrowser).
            if (req.mcpConfigPath)
                argv.push("--mcp-config", req.mcpConfigPath);
            // Prompt is piped via stdin so it is not exposed via process argv.
            const child = spawn(cmd, argv, {
                timeout,
                killSignal: "SIGKILL",
                stdio: ["pipe", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            child.stdout.on("data", (d) => { out += d.toString(); });
            child.stderr.on("data", (d) => { err += d.toString(); });
            child.on("error", (e) => reject(new Error(`spawn failed: ${e.message}`)));
            child.stdin.write(cleanPrompt);
            child.stdin.end();
            child.on("close", (code, signal) => {
                if (signal)
                    return reject(new Error(`codex killed (${signal}) — timeout?`));
                if (code !== 0) {
                    // Codex errors on stderr — no structured limit detection like Claude.
                    // Just report exit code + first 300 chars of stderr.
                    return reject(new Error(`codex exit ${code}: ${err.slice(0, 300)}`));
                }
                const trimmed = out.trim();
                if (!trimmed)
                    return reject(new Error("codex returned empty output"));
                resolve(trimmed);
            });
        });
        let schemaJson = null;
        if (req.schema && text) {
            // Strip ```json fence if present.
            const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
            try {
                schemaJson = JSON.parse(cleaned);
            }
            catch (_e) {
                schemaJson = null;
            }
        }
        // CLI gives no token counts — estimate so budget guard still works.
        const tokensIn = this.estimateTokens(cleanPrompt);
        const tokensOut = this.estimateTokens(text);
        return { text, schemaJson, tokensIn, tokensOut };
    }
    estimateTokens(prompt) {
        // OpenAI heuristic: ~3 chars/token (similar to Anthropic for consistency).
        return Math.ceil((prompt || "").length / 3);
    }
}
module.exports = { CodexCLIAdapter };
//# sourceMappingURL=codex-cli.js.map