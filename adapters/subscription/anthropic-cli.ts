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
const { IAIAdapter } = require("../adapter-interface");
const limitState = require("../../lib/claude-limit/state");
const { detectClaudeLimit } = require("../../lib/claude-limit/detect");
const { ClaudeCliLimitError } = require("../../lib/claude-limit/error");

const DEFAULT_TIMEOUT_MS = 90_000;

interface AdapterCompleteRequest {
  prompt: string;
  model: string;                // 2026-07-07: now passed as `--model <name>`
                                //   when non-empty. Falls back to CLI default
                                //   (subscription plan default) if empty.
  maxOutputTokens: number;      // unused — CLI doesn't accept a cap
  schema?: Record<string, unknown> | null;
  skill?: string;               // optional; used for limit tracking
  // systemPromptCacheable ignored — Claude CLI subscription is flat-fee, no token cache benefit
  systemPromptCacheable?: boolean;
  // anthropic-cli extras (from policy binding):
  timeoutMs?: number;
  allowedTools?: string;        // CSV, empty = no tools
  // MCP server config — loads mcpServers definition for tool_use.
  // Used by crawler (CloakBrowser) + any skill needing MCP tools.
  mcpConfigPath?: string;
  // Endpoint override (resolved by authz/engine.ts from NEXUS_CLAUDE_BASE_URL,
  // 2026-07-10). Empty/unset → CLI falls back to its own default (direct API).
  baseUrl?: string;
}

interface AdapterCompleteResponse {
  text: string | null;
  schemaJson: unknown | null;
  tokensIn: number;
  tokensOut: number;
}

function _cliBin(): string {
  return (process.env.CLAUDE_CLI_BIN || "").trim() || "claude";
}

function _cliInvocation(): [string, string[]] {
  const bin = _cliBin();
  // claude-code's cli.js mounted from host → container may need explicit `node`.
  if (bin.endsWith(".js")) return ["node", [bin]];
  return [bin, []];
}

// Claude Code CLI (`claude -p --model`) only accepts short aliases
// ("haiku"/"sonnet"/"opus"), NOT full model IDs. Passing a full ID like
// "claude-sonnet-4-6" fails: "issue with the selected model ... may not exist".
// The gateway registry feeds full IDs, so normalize here. Alias resolves to
// the CLI's current version of that tier → resilient to model version drift.
function _toCliModel(model: string): string {
  const m = String(model || "").trim().toLowerCase();
  if (!m) return "";                      // empty → CLI subscription default
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return String(model).trim();            // non-anthropic / already-alias → passthrough
}

class AnthropicCLIAdapter extends IAIAdapter {
  get provider(): string {
    return "anthropic-cli";
  }

  async complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse> {
    const timeout = req.timeoutMs || DEFAULT_TIMEOUT_MS;
    const allowedTools = req.allowedTools || "";
    const skill = req.skill || "unknown";

    // Pre-check: if skill is in cooldown, throw error immediately (avoid spawn).
    const skipCheck = limitState.shouldSkip(skill);
    if (skipCheck.skip) {
      throw new ClaudeCliLimitError(skill, {
        kind: skipCheck.kind,
        resetAt: skipCheck.resetAt,
        raw: "cooldown active",
      });
    }

    // Strip null bytes — spawn() rejects null in argv. PDF text may contain \x00.
    const cleanPrompt = String(req.prompt).replace(/\x00/g, "");

    const text = await new Promise<string>((resolve, reject) => {
      const [cmd, prefix] = _cliInvocation();
      const argv = [...prefix, "--permission-mode", "acceptEdits"];
      // Model — pass alias resolved from policy/env-override value. Normalize
      // full IDs → CLI alias (CLI rejects full IDs; see _toCliModel). Skip if
      // empty so CLI keeps subscription default.
      const modelArg = _toCliModel(req.model);
      if (modelArg) argv.push("--model", modelArg);
      if (allowedTools) argv.push("--allowedTools", allowedTools);
      // MCP config — needed by skills that use MCP tools (crawler CloakBrowser etc.)
      if (req.mcpConfigPath) argv.push("--mcp-config", req.mcpConfigPath);
      argv.push("-p", cleanPrompt);

      // Endpoint switch (2026-07-10): pass resolved baseUrl into the child's
      // env explicitly rather than relying on inherited process env, so the
      // per-vendor NEXUS_CLAUDE_BASE_URL override (or empty → direct API)
      // always wins regardless of what the parent process has set.
      const child = spawn(cmd, argv, {
        timeout,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ANTHROPIC_BASE_URL: String(req.baseUrl || "").trim() },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", (e: Error) => reject(new Error(`spawn failed: ${e.message}`)));
      child.on("close", (code: number | null, signal: string | null) => {
        if (signal) return reject(new Error(`claude killed (${signal}) — timeout?`));
        if (code !== 0) {
          // CLI prints auth/usage errors to stdout OR stderr depending on
          // failure mode (401 auth → stdout; some limits → stderr). Combine
          // both so detection + the surfaced message never come back empty.
          const diag = [err.trim(), out.trim()].filter(Boolean).join(" | ");
          // Try to detect limit hit from combined output.
          const match = detectClaudeLimit(diag);
          if (match) {
            limitState.markLimitHit(skill, match);
            return reject(new ClaudeCliLimitError(skill, match));
          }
          // Generic error — include combined diag (was stderr-only → empty on
          // stdout-only failures like the 401 auth error).
          return reject(new Error(`claude exit ${code}: ${(diag || "(no output)").slice(0, 300)}`));
        }
        const trimmed = out.trim();
        if (!trimmed) return reject(new Error("claude returned empty output"));
        // Success — clear any prior cooldown for this skill.
        limitState.clearLimit(skill);
        resolve(trimmed);
      });
    });

    let schemaJson: unknown | null = null;
    if (req.schema && text) {
      // Strip ```json fence if present.
      const cleaned = text.replace(/^```json\s*|\s*```$/g, "");
      try { schemaJson = JSON.parse(cleaned); } catch (_e) { schemaJson = null; }
    }

    // CLI gives no token counts — estimate so budget guard still works.
    const tokensIn = this.estimateTokens(cleanPrompt);
    const tokensOut = this.estimateTokens(text);

    return { text, schemaJson, tokensIn, tokensOut };
  }

  estimateTokens(prompt: string): number {
    // Anthropic heuristic: ~3 chars/token (conservative for VN/CJK mix).
    return Math.ceil((prompt || "").length / 3);
  }
}

export = { AnthropicCLIAdapter, _toCliModel };
