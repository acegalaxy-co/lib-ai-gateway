"use strict";

// ai-gateway/adapters/anthropic-cli.ts
// Phase 3b adapter — Claude Code CLI subprocess for batch/cron tasks.
// Uses Max subscription (no API key), no streaming. Mirrors logic from
// src/app/llm/claude-cli.ts (the legacy callsite this replaces).
//
// Token usage: CLI does not return per-call token counts. We estimate from
// prompt + output length so budget guard still gets a signal.

const { spawn } = require("child_process");
const { IAIAdapter } = require("./adapter-interface");

const DEFAULT_TIMEOUT_MS = 90_000;

interface AdapterCompleteRequest {
  prompt: string;
  model: string;                // unused — CLI picks subscription default
  maxOutputTokens: number;      // unused — CLI doesn't accept a cap
  schema?: Record<string, unknown> | null;
  // anthropic-cli extras (from policy binding):
  timeoutMs?: number;
  allowedTools?: string;        // CSV, empty = no tools
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

class AnthropicCLIAdapter extends IAIAdapter {
  get provider(): string {
    return "anthropic-cli";
  }

  async complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse> {
    const timeout = req.timeoutMs || DEFAULT_TIMEOUT_MS;
    const allowedTools = req.allowedTools || "";
    // Strip null bytes — spawn() rejects null in argv. PDF text may contain \x00.
    const cleanPrompt = String(req.prompt).replace(/\x00/g, "");

    const text = await new Promise<string>((resolve, reject) => {
      const [cmd, prefix] = _cliInvocation();
      const argv = [...prefix, "--permission-mode", "acceptEdits"];
      if (allowedTools) argv.push("--allowedTools", allowedTools);
      argv.push("-p", cleanPrompt);

      const child = spawn(cmd, argv, {
        timeout,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", (e: Error) => reject(new Error(`spawn failed: ${e.message}`)));
      child.on("close", (code: number | null, signal: string | null) => {
        if (signal) return reject(new Error(`claude killed (${signal}) — timeout?`));
        if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
        const trimmed = out.trim();
        if (!trimmed) return reject(new Error("claude returned empty output"));
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

export = { AnthropicCLIAdapter };
