"use strict";
// ai-gateway/adapters/anthropic-cli.ts
// Phase 3b adapter — Claude Code CLI subprocess for batch/cron tasks.
// Uses Max subscription (no API key), no streaming. Mirrors logic from
// src/app/llm/claude-cli.ts (the legacy callsite this replaces).
//
// Token usage: CLI does not return per-call token counts. We estimate from
// prompt + output length so budget guard still gets a signal.
//
// Limit detection: pre-check cooldown before spawn; parse stderr reactively
// for session_5h / weekly_7d / rate_limit. Throw ClaudeCliLimitError on hit.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { IAIAdapter } = require("../adapter-interface");
const limitState = require("../../lib/claude-limit/state");
const { detectClaudeLimit } = require("../../lib/claude-limit/detect");
const { ClaudeCliLimitError } = require("../../lib/claude-limit/error");
const DEFAULT_TIMEOUT_MS = 90_000;
function _cliBin() {
    return (process.env.CLAUDE_CLI_BIN || "").trim() || "claude";
}
function _cliInvocation() {
    const bin = _cliBin();
    // claude-code's cli.js mounted from host → container may need explicit `node`.
    if (bin.endsWith(".js"))
        return ["node", [bin]];
    return [bin, []];
}
// Claude Code CLI (`claude -p --model`) only accepts short aliases
// ("haiku"/"sonnet"/"opus"), NOT full model IDs. Passing a full ID like
// "claude-sonnet-4-6" fails: "issue with the selected model ... may not exist".
// The gateway registry feeds full IDs, so normalize here. Alias resolves to
// the CLI's current version of that tier → resilient to model version drift.
function _toCliModel(model) {
    const m = String(model || "").trim().toLowerCase();
    if (!m)
        return ""; // empty → CLI subscription default
    if (m.includes("opus"))
        return "opus";
    if (m.includes("sonnet"))
        return "sonnet";
    if (m.includes("haiku"))
        return "haiku";
    return String(model).trim(); // non-anthropic / already-alias → passthrough
}
const DEFAULT_PROVIDER = "anthropic-cli";
// Slim mode (crawler.extract / crawler.join): drop Claude Code's default system prompt,
// built-in tool defs, skills and the caller repo's CLAUDE.md/project settings.
// Measured 2026-10-10: fixed per-request context 54.9k → 1.4k tokens; MCP
// tools (CloakBrowser via --mcp-config + --allowedTools) still work.
// Kill switch: AI_GATEWAY_CLI_SLIM=0. CLAUDE.md no longer loads, so the
// default system prompt carries the safety constraints it used to provide.
const SLIM_SYSTEM_PROMPT = [
    "You are a browser-automation extraction agent. Use only the provided MCP browser tools.",
    "Do NOT log in, re-authenticate, solve captchas or bypass any security/checkpoint; if access is blocked or the session is not authenticated, stop and return {\"error\":\"session_expired\",\"message\":\"...\"}.",
    "Only extract information visible in public posts/comments/pages.",
    "Prefer cloak_evaluate with targeted JS returning only the needed text; avoid full-page cloak_snapshot/cloak_read_page unless evaluate cannot work.",
    "Return ONLY valid JSON as instructed by the task. No markdown, no prose.",
].join("\n");
function _slimEnabled(skill) {
    if (String(process.env.AI_GATEWAY_CLI_SLIM || "").trim() === "0")
        return false;
    // crawler.login excluded: it waits for a manual login, which the slim
    // "not authenticated → stop" rule would cut short.
    return skill === "crawler.extract" || skill === "crawler.join";
}
function _slimCwd() {
    // Empty dir → no CLAUDE.md / .claude/ project settings auto-discovered.
    const dir = path.join(os.tmpdir(), "ai-gateway-cli-slim");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
class AnthropicCLIAdapter extends IAIAdapter {
    _provider;
    // Non-default provider (e.g. "antigravity-cli": Claude Code CLI pointed at a
    // proxy that routes `--model antigravity/...` to Gemini) gets its own
    // limit-cooldown key and a verbatim model arg. Breaker isolation is handled
    // by dispatchCall keying on the provider string.
    constructor(opts = {}) {
        super();
        this._provider = (opts && opts.provider) || DEFAULT_PROVIDER;
    }
    get provider() {
        return this._provider;
    }
    async complete(req) {
        const timeout = req.timeoutMs || DEFAULT_TIMEOUT_MS;
        const allowedTools = req.allowedTools || "";
        const skill = req.skill || "unknown";
        const isDefault = this._provider === DEFAULT_PROVIDER;
        // Limit-state key: bare skill for Claude (unchanged), namespaced otherwise.
        const limitKey = isDefault ? skill : `${this._provider}:${skill}`;
        // Pre-check: if skill is in cooldown, throw error immediately (avoid spawn).
        const skipCheck = limitState.shouldSkip(limitKey);
        if (skipCheck.skip) {
            throw new ClaudeCliLimitError(skill, {
                kind: skipCheck.kind,
                resetAt: skipCheck.resetAt,
                raw: "cooldown active",
            });
        }
        // Strip null bytes — spawn() rejects null in argv. PDF text may contain \x00.
        const cleanPrompt = String(req.prompt).replace(/\x00/g, "");
        const text = await new Promise((resolve, reject) => {
            const [cmd, prefix] = _cliInvocation();
            const argv = [...prefix, "--permission-mode", "acceptEdits"];
            // Model — pass alias resolved from policy/env-override value. Normalize
            // full IDs → CLI alias (CLI rejects full IDs; see _toCliModel). Skip if
            // empty so CLI keeps subscription default.
            const modelArg = isDefault ? _toCliModel(req.model) : String(req.model || "").trim();
            if (modelArg)
                argv.push("--model", modelArg);
            if (allowedTools)
                argv.push("--allowedTools", allowedTools);
            // MCP config — needed by skills that use MCP tools (crawler CloakBrowser etc.)
            if (req.mcpConfigPath)
                argv.push("--mcp-config", path.resolve(req.mcpConfigPath));
            const slim = _slimEnabled(skill);
            if (slim) {
                const sys = String(req.systemPrompt || "").trim();
                argv.push("--system-prompt", sys ? `${SLIM_SYSTEM_PROMPT}\n\n${sys}` : SLIM_SYSTEM_PROMPT, "--tools", "", "--disable-slash-commands", "--strict-mcp-config");
            }
            argv.push("-p", cleanPrompt);
            // Endpoint switch (2026-07-10): pass resolved baseUrl into the child's
            // env explicitly rather than relying on inherited process env, so the
            // per-vendor NEXUS_CLAUDE_BASE_URL override (or empty → direct API)
            // always wins regardless of what the parent process has set.
            // detached: true → child gets its own process group (pgid = child.pid).
            // On timeout we SIGKILL the whole group so MCP server children
            // (CloakBrowser/Chromium) spawned by the CLI die too, instead of
            // surviving and keeping the browser profile locked.
            const child = spawn(cmd, argv, {
                detached: true,
                ...(slim ? { cwd: _slimCwd() } : {}),
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, ANTHROPIC_BASE_URL: String(req.baseUrl || "").trim() },
            });
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
                    return reject(new Error(`claude killed (${signal}) — timeout?`));
                if (code !== 0) {
                    // CLI prints auth/usage errors to stdout OR stderr depending on
                    // failure mode (401 auth → stdout; some limits → stderr). Combine
                    // both so detection + the surfaced message never come back empty.
                    const diag = [err.trim(), out.trim()].filter(Boolean).join(" | ");
                    // Try to detect limit hit from combined output.
                    const match = detectClaudeLimit(diag);
                    if (match) {
                        limitState.markLimitHit(limitKey, match);
                        return reject(new ClaudeCliLimitError(skill, match));
                    }
                    // Generic error — include combined diag (was stderr-only → empty on
                    // stdout-only failures like the 401 auth error).
                    return reject(new Error(`claude exit ${code}: ${(diag || "(no output)").slice(0, 300)}`));
                }
                const trimmed = out.trim();
                if (!trimmed)
                    return reject(new Error("claude returned empty output"));
                // Success — clear any prior cooldown for this skill.
                limitState.clearLimit(limitKey);
                resolve(trimmed);
            });
        });
        let schemaJson = null;
        if (req.schema && text) {
            // Strip ```json fence if present.
            const cleaned = text.replace(/^```json\s*|\s*```$/g, "");
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
        // Anthropic heuristic: ~3 chars/token (conservative for VN/CJK mix).
        return Math.ceil((prompt || "").length / 3);
    }
}
module.exports = { AnthropicCLIAdapter, _toCliModel };
//# sourceMappingURL=anthropic-cli.js.map