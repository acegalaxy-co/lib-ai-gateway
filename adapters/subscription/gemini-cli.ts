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

interface AdapterCompleteRequest {
  prompt: string;
  model: string;                // e.g. "gemini-2.5-pro"; empty = CLI default
  maxOutputTokens: number;      // unused — CLI doesn't accept a cap
  schema?: Record<string, unknown> | null;
  skill?: string;               // optional; used for logging/context
  timeoutMs?: number;
  // Browse options (2026-09-28) — gateway now owns gemini CLI spawns for
  // consumers doing browser/MCP tasks (was previously spawned by the
  // consumer directly, which violated the CLI-spawns-live-in-adapters rule).
  // All optional; unset → behaviour identical to before this change.
  cwd?: string;                          // spawn cwd — gemini reads project-scope .gemini/settings.json (MCP servers) from here
  yolo?: boolean;                        // --yolo
  outputJson?: boolean;                  // -o json + parse CLI envelope
  allowedMcpServerNames?: string[];      // --allowed-mcp-server-names <name>, one flag per entry
  coreTools?: string[];                  // written to a temp GEMINI_CLI_SYSTEM_SETTINGS_PATH file
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

    // coreTools → temp GEMINI_CLI_SYSTEM_SETTINGS_PATH file. Created before
    // spawn, removed in the finally below (success or failure alike).
    let tmpDir: string | null = null;
    let env = process.env;
    if (Array.isArray(req.coreTools)) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-settings-"));
      const settingsPath = path.join(tmpDir, "settings.json");
      fs.writeFileSync(settingsPath, JSON.stringify({ coreTools: req.coreTools }));
      env = { ...process.env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath };
    }

    let text: string;
    try {
      text = await new Promise<string>((resolve, reject) => {
        const [cmd, prefix] = _cliInvocation();
        const argv = [...prefix];

        // Model — pass explicit name if policy or env override resolved a value.
        // Skip if empty so CLI keeps Code Assist default.
        const modelArg = String(req.model || "").trim();
        if (modelArg) argv.push("-m", modelArg);

        if (req.yolo) argv.push("--yolo");
        if (req.outputJson) argv.push("-o", "json");
        if (Array.isArray(req.allowedMcpServerNames)) {
          for (const name of req.allowedMcpServerNames) argv.push("--allowed-mcp-server-names", name);
        }

        // Non-interactive mode: -p with stdin prints response and exits.
        // P0: pipe prompt via stdin — argv would expose content via `ps aux`.
        argv.push("-p", "-");

        const spawnOpts: Record<string, unknown> = {
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          env,
        };
        if (req.cwd) spawnOpts.cwd = req.cwd;

        const child = spawn(cmd, argv, spawnOpts);

        // detached: true → child owns its process group (pgid = child.pid).
        // Timeout SIGKILLs the whole group so MCP server children
        // (CloakBrowser/Chromium) don't survive and keep the browser
        // profile locked.
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (_e) {
            try { child.kill("SIGKILL"); } catch (_e2) { /* already dead */ }
          }
        }, timeout);

        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
        child.on("error", (e: Error) => { clearTimeout(timer); reject(new Error(`spawn failed: ${e.message}`)); });

        child.on("close", (code: number | null, signal: string | null) => {
          clearTimeout(timer);
          if (signal) return reject(new Error(`gemini killed (${signal}) — timeout?`));
          if (code !== 0) {
            return reject(new Error(`gemini exit ${code}: ${err.slice(0, 300)}`));
          }
          const trimmed = out.trim();
          if (!trimmed) return reject(new Error("gemini returned empty output"));

          if (!req.outputJson) return resolve(trimmed);

          // -o json: CLI wraps the model output in a JSON envelope. Model
          // text lives under `response`, older CLI builds use `result`/`text`.
          let envelope: any;
          try {
            envelope = JSON.parse(trimmed);
          } catch (_e) {
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
    } finally {
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
      }
    }

    let schemaJson: unknown | null = null;
    if (req.schema && text) {
      // Strip ```json fence if present.
      const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
      try {
        schemaJson = JSON.parse(cleaned);
      } catch (_e) {
        // Fallback: extract the first [...] or {...} block from noisy output.
        const match = cleaned.match(/[[{][\s\S]*[\]}]/);
        if (match) {
          try { schemaJson = JSON.parse(match[0]); } catch (_e2) { schemaJson = null; }
        }
      }
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
