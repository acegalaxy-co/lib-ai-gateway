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
const { IAIAdapter } = require("./adapter-interface");

const DEFAULT_TIMEOUT_MS = 90_000;

interface AdapterCompleteRequest {
  prompt: string;
  model: string;                // e.g. "gemini-2.5-pro"; empty = CLI default
  maxOutputTokens: number;      // unused — CLI doesn't accept a cap
  schema?: Record<string, unknown> | null;
  skill?: string;               // optional; used for logging/context
  timeoutMs?: number;
}

interface AdapterCompleteResponse {
  text: string | null;
  schemaJson: unknown | null;
  tokensIn: number;
  tokensOut: number;
}

function _cliBin(): string {
  return (process.env.GEMINI_CLI_BIN || "").trim() || "gemini";
}

function _cliInvocation(): [string, string[]] {
  const bin = _cliBin();
  // gemini CLI mounted from host → container may need explicit `node`.
  if (bin.endsWith(".js")) return ["node", [bin]];
  return [bin, []];
}

class GeminiCLIAdapter extends IAIAdapter {
  get provider(): string {
    return "gemini-cli";
  }

  async complete(req: AdapterCompleteRequest): Promise<AdapterCompleteResponse> {
    const timeout = req.timeoutMs || DEFAULT_TIMEOUT_MS;
    const skill = req.skill || "unknown";

    // Strip null bytes — spawn() rejects null in argv. PDF text may contain \x00.
    const cleanPrompt = String(req.prompt).replace(/\x00/g, "");

    const text = await new Promise<string>((resolve, reject) => {
      const [cmd, prefix] = _cliInvocation();
      const argv = [...prefix];

      // Model — pass explicit name if policy or env override resolved a value.
      // Skip if empty so CLI keeps Code Assist default.
      const modelArg = String(req.model || "").trim();
      if (modelArg) argv.push("-m", modelArg);

      // Non-interactive mode: -p with stdin prints response and exits.
      // P0: pipe prompt via stdin — argv would expose content via `ps aux`.
      argv.push("-p", "-");

      const child = spawn(cmd, argv, {
        timeout,
        killSignal: "SIGKILL",
        stdio: ["pipe", "pipe", "pipe"],
      });

      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", (e: Error) => reject(new Error(`spawn failed: ${e.message}`)));

      child.on("close", (code: number | null, signal: string | null) => {
        if (signal) return reject(new Error(`gemini killed (${signal}) — timeout?`));
        if (code !== 0) {
          return reject(new Error(`gemini exit ${code}: ${err.slice(0, 300)}`));
        }
        const trimmed = out.trim();
        if (!trimmed) return reject(new Error("gemini returned empty output"));
        resolve(trimmed);
      });

      // Write prompt to stdin.
      child.stdin.write(cleanPrompt);
      child.stdin.end();
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
    // Gemini heuristic: ~3 chars/token (same as anthropic-cli).
    return Math.ceil((prompt || "").length / 3);
  }
}

export = { GeminiCLIAdapter };
