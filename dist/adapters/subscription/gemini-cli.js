"use strict";
// ai-gateway/adapters/gemini-cli.ts
// Phase 3b adapter — Gemini CLI subprocess for batch/cron tasks.
// Uses Code Assist subscription (OAuth, no API key), no streaming.
// Mirrors logic from anthropic-cli.ts adapted for Gemini CLI.
//
// Token usage: CLI does not return per-call token counts. We estimate from
// prompt + output length so budget guard still gets a signal.
//
// Limit detection: Gemini CLI has no session_5h/weekly_7d equivalent.
// Parse spawn errors + non-zero exit with generic error message.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { IAIAdapter } = require("../adapter-interface");
const DEFAULT_TIMEOUT_MS = 90_000;
function _cliBin() {
    return (process.env.GEMINI_CLI_BIN || "").trim() || "gemini";
}
function _cliInvocation() {
    const bin = _cliBin();
    // gemini CLI mounted from host → container may need explicit `node`.
    if (bin.endsWith(".js"))
        return ["node", [bin]];
    return [bin, []];
}
class GeminiCLIAdapter extends IAIAdapter {
    get provider() {
        return "gemini-cli";
    }
    async complete(req) {
        const timeout = req.timeoutMs || DEFAULT_TIMEOUT_MS;
        const skill = req.skill || "unknown";
        // Strip null bytes — spawn() rejects null in argv. PDF text may contain \x00.
        const cleanPrompt = String(req.prompt).replace(/\x00/g, "");
        // coreTools → temp GEMINI_CLI_SYSTEM_SETTINGS_PATH file. Created before
        // spawn, removed in the finally below (success or failure alike).
        // 2026-09-28: gemini-cli >=0.4x reads tool restriction from the nested
        // `tools.core` key — a flat `{"coreTools":[...]}` is silently ignored
        // (verified live: shell stayed enabled under --yolo with the flat key;
        // a real `touch` call succeeded). Keep our request field named
        // `coreTools`, just nest it correctly for the CLI.
        let tmpDir = null;
        let env = process.env;
        if (Array.isArray(req.coreTools)) {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-settings-"));
            const settingsPath = path.join(tmpDir, "settings.json");
            fs.writeFileSync(settingsPath, JSON.stringify({ tools: { core: req.coreTools } }));
            env = { ...process.env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath };
        }
        let text;
        try {
            text = await new Promise((resolve, reject) => {
                const [cmd, prefix] = _cliInvocation();
                const argv = [...prefix];
                // Model — pass explicit name if policy or env override resolved a value.
                // Skip if empty so CLI keeps Code Assist default.
                const modelArg = String(req.model || "").trim();
                if (modelArg)
                    argv.push("-m", modelArg);
                if (req.yolo)
                    argv.push("--yolo");
                if (req.outputJson)
                    argv.push("-o", "json");
                if (Array.isArray(req.allowedMcpServerNames)) {
                    for (const name of req.allowedMcpServerNames)
                        argv.push("--allowed-mcp-server-names", name);
                }
                // Non-interactive mode: -p with stdin prints response and exits.
                // P0: pipe prompt via stdin — argv would expose content via `ps aux`.
                argv.push("-p", "-");
                const spawnOpts = {
                    detached: true,
                    stdio: ["pipe", "pipe", "pipe"],
                    env,
                };
                if (req.cwd)
                    spawnOpts.cwd = req.cwd;
                const child = spawn(cmd, argv, spawnOpts);
                // detached: true → child owns its process group (pgid = child.pid).
                // Timeout SIGKILLs the whole group so MCP server children
                // (CloakBrowser/Chromium) don't survive and keep the browser
                // profile locked.
                const timer = setTimeout(() => {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                    }
                    catch (_e) {
                        try {
                            child.kill("SIGKILL");
                        }
                        catch (_e2) { /* already dead */ }
                    }
                }, timeout);
                let out = "";
                let err = "";
                child.stdout.on("data", (d) => { out += d.toString(); });
                child.stderr.on("data", (d) => { err += d.toString(); });
                child.on("error", (e) => { clearTimeout(timer); reject(new Error(`spawn failed: ${e.message}`)); });
                child.on("close", (code, signal) => {
                    clearTimeout(timer);
                    if (signal)
                        return reject(new Error(`gemini killed (${signal}) — timeout?`));
                    if (code !== 0) {
                        return reject(new Error(`gemini exit ${code}: ${err.slice(0, 300)}`));
                    }
                    const trimmed = out.trim();
                    if (!trimmed)
                        return reject(new Error("gemini returned empty output"));
                    if (!req.outputJson)
                        return resolve(trimmed);
                    // -o json: CLI wraps the model output in a JSON envelope. Model
                    // text lives under `response`, older CLI builds use `result`/`text`.
                    let envelope;
                    try {
                        envelope = JSON.parse(trimmed);
                    }
                    catch (_e) {
                        return reject(new Error("gemini -o json returned non-JSON envelope"));
                    }
                    const modelText = envelope && (envelope.response ?? envelope.result ?? envelope.text);
                    if (typeof modelText !== "string" || !modelText) {
                        return reject(new Error("gemini -o json returned non-JSON envelope"));
                    }
                    resolve(modelText);
                });
                // Write prompt to stdin.
                child.stdin.write(cleanPrompt);
                child.stdin.end();
            });
        }
        finally {
            if (tmpDir) {
                try {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                }
                catch (_e) { /* best effort */ }
            }
        }
        let schemaJson = null;
        if (req.schema && text) {
            // Strip ```json fence if present.
            const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
            try {
                schemaJson = JSON.parse(cleaned);
            }
            catch (_e) {
                // Fallback: extract the first [...] or {...} block from noisy output.
                const match = cleaned.match(/[[{][\s\S]*[\]}]/);
                if (match) {
                    try {
                        schemaJson = JSON.parse(match[0]);
                    }
                    catch (_e2) {
                        schemaJson = null;
                    }
                }
            }
        }
        // CLI gives no token counts — estimate so budget guard still works.
        const tokensIn = this.estimateTokens(cleanPrompt);
        const tokensOut = this.estimateTokens(text);
        return { text, schemaJson, tokensIn, tokensOut };
    }
    estimateTokens(prompt) {
        // Gemini heuristic: ~3 chars/token (same as anthropic-cli).
        return Math.ceil((prompt || "").length / 3);
    }
}
module.exports = { GeminiCLIAdapter };
//# sourceMappingURL=gemini-cli.js.map