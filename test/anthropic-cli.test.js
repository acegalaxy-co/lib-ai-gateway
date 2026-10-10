"use strict";

// commons/ai-gateway/test/anthropic-cli.test.js
// Mocks child_process.spawn to avoid invoking the real `claude` CLI.
// Validates argv shape, stdout capture, exit-code error handling, JSON schema parse.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// Intercept `require("child_process")` BEFORE the adapter is required.
// node:test runs each test() top-down in the same process; we replace
// require.cache for child_process so the adapter picks up our stub.
const cpModule = require("child_process");
const origSpawn = cpModule.spawn;

function _makeStub(stdoutChunks, stderrChunks, exitCode = 0, signal = null, captureArgv = null) {
  return function _spawnStub(cmd, argv, _opts) {
    if (captureArgv) {
      captureArgv.cmd = cmd;
      captureArgv.argv = argv;
      captureArgv.opts = _opts;
    }
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Emit on next tick so the listener gets attached first.
    setImmediate(() => {
      for (const c of stdoutChunks) child.stdout.emit("data", Buffer.from(c));
      for (const c of stderrChunks) child.stderr.emit("data", Buffer.from(c));
      child.emit("close", exitCode, signal);
    });
    return child;
  };
}

function _withSpawn(stub, fn) {
  cpModule.spawn = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => { cpModule.spawn = origSpawn; });
}

// Adapter is required AFTER possibly replacing spawn, but it captures `spawn`
// at module top-level. Bust the cache so each test gets a fresh require.
function _loadAdapter() {
  const adapterPath = path.join(__dirname, "..", "dist", "adapters", "subscription", "anthropic-cli.js");
  delete require.cache[require.resolve(adapterPath)];
  return require(adapterPath).AnthropicCLIAdapter;
}

test("anthropic-cli: success path → stdout becomes text, tokens estimated", async () => {
  const captured = {};
  const stub = _makeStub(["Hello", " world\n"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    const r = await adapter.complete({
      prompt: "say hi",
      model: "claude-sonnet-4-6",
      maxOutputTokens: 100,
    });
    assert.equal(r.text, "Hello world");
    assert.ok(r.tokensIn > 0);
    assert.ok(r.tokensOut > 0);
    assert.equal(r.schemaJson, null);
    // argv shape: [..., --permission-mode acceptEdits, -p <prompt>]
    assert.ok(captured.argv.includes("--permission-mode"));
    assert.ok(captured.argv.includes("acceptEdits"));
    assert.ok(captured.argv.includes("-p"));
    assert.equal(captured.argv[captured.argv.length - 1], "say hi");
  });
});

test("anthropic-cli: allowedTools binding → injected before -p", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "search news",
      model: "m", maxOutputTokens: 100,
      allowedTools: "WebSearch,Bash",
    });
    const idxTools = captured.argv.indexOf("--allowedTools");
    const idxP = captured.argv.indexOf("-p");
    assert.ok(idxTools > -1);
    assert.equal(captured.argv[idxTools + 1], "WebSearch,Bash");
    assert.ok(idxTools < idxP, "tools must precede -p so prompt isn't swallowed");
  });
});

test("anthropic-cli: non-zero exit → reject with stderr", async () => {
  const stub = _makeStub(["partial"], ["error: bad request\n"], 1);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100 }),
      /claude exit 1.*bad request/
    );
  });
});

test("anthropic-cli: non-zero exit with error on STDOUT only → surfaced in message", async () => {
  // Regression: claude CLI prints 401 auth error to stdout (not stderr) then
  // exits non-zero. Old code used stderr-only → "claude exit 1:" empty message.
  const stub = _makeStub(
    ['Failed to authenticate. API Error: 401 {"type":"authentication_error"}'],
    [],
    1,
  );
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100 }),
      /claude exit 1.*401.*authentication/,
    );
  });
});

test("anthropic-cli: timeout signal → reject with kill reason", async () => {
  const stub = _makeStub([], [], null, "SIGKILL");
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100, timeoutMs: 50 }),
      /killed.*SIGKILL/
    );
  });
});

test("anthropic-cli: empty stdout → reject", async () => {
  const stub = _makeStub([""], [], 0);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100 }),
      /empty output/
    );
  });
});

test("anthropic-cli: schema + JSON-fenced output → schemaJson parsed", async () => {
  const stub = _makeStub(['```json\n{"vendor":"Anthropic"}\n```'], [], 0);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    const r = await adapter.complete({
      prompt: "extract", model: "m", maxOutputTokens: 100,
      schema: { type: "object" },
    });
    assert.deepEqual(r.schemaJson, { vendor: "Anthropic" });
  });
});

test("anthropic-cli: null bytes in prompt are stripped before spawn", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "hello\x00world",
      model: "m", maxOutputTokens: 100,
    });
    const last = captured.argv[captured.argv.length - 1];
    assert.equal(last, "helloworld");
    assert.ok(!last.includes("\x00"));
  });
});

// ============================================================
// 2026-07-07: --model flag support (was previously ignored).
// Adapter must pass `--model <name>` to CLI when model is non-empty,
// so policy binding (or env override resolved by dispatchCall) actually
// takes effect. Empty model → skip flag, CLI falls back to subscription
// default (backward-compat with earlier callers passing model:"m" etc.).
// ============================================================
test("anthropic-cli: model non-empty → --model <alias> in argv before -p", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "extract",
      model: "claude-haiku-4-5",
      maxOutputTokens: 100,
    });
    const idxModel = captured.argv.indexOf("--model");
    const idxP = captured.argv.indexOf("-p");
    assert.ok(idxModel > -1, "--model flag must be present when model non-empty");
    // 2026-07-19: full ID normalized to CLI alias (CLI rejects full IDs).
    assert.equal(captured.argv[idxModel + 1], "haiku");
    assert.ok(idxModel < idxP, "--model must precede -p so prompt isn't swallowed");
  });
});

test("anthropic-cli: empty model → --model flag omitted (CLI default)", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "extract",
      model: "",
      maxOutputTokens: 100,
    });
    assert.equal(captured.argv.indexOf("--model"), -1, "--model must be omitted for empty model");
  });
});

test("anthropic-cli: whitespace-only model → --model omitted (treated as empty)", async () => {
  const captured = {};
  const stub = _makeStub(["ok"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({
      prompt: "extract",
      model: "   ",
      maxOutputTokens: 100,
    });
    assert.equal(captured.argv.indexOf("--model"), -1, "--model must be omitted for whitespace-only");
  });
});

// ============================================================
// 2026-09-28: process-group kill. spawn() no longer takes `timeout` — the
// adapter runs its own setTimeout + SIGKILLs the whole process group
// (`process.kill(-child.pid, ...)`) so MCP server children (CloakBrowser/
// Chromium) don't survive a timeout and keep the browser profile locked.
// ============================================================
test("anthropic-cli: spawns detached (process-group kill prerequisite), no `timeout` spawn opt", async () => {
  const optsCapture = {};
  const stub = function _spawnStub(_cmd, _argv, opts) {
    optsCapture.opts = opts;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("ok"));
      child.emit("close", 0, null);
    });
    return child;
  };
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100 });
  });
  assert.equal(optsCapture.opts.detached, true);
  assert.equal(optsCapture.opts.timeout, undefined, "timeout must move off spawn opts (own setTimeout handles it now)");
});

test("anthropic-cli: timeout kills whole process group (grandchild dies with parent)", { skip: process.platform === "win32" }, async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pgkill-"));
  const scriptPath = path.join(tmpDir, "fake-claude.sh");
  const pidFile = path.join(tmpDir, "grandchild.pid");
  fs.writeFileSync(scriptPath, "#!/bin/sh\nsleep 60 &\necho $! > \"$PIDFILE\"\nwait\n");
  fs.chmodSync(scriptPath, 0o755);

  const origBin = process.env.CLAUDE_CLI_BIN;
  const origPidFile = process.env.PIDFILE;
  process.env.CLAUDE_CLI_BIN = scriptPath;
  process.env.PIDFILE = pidFile;

  try {
    const AnthropicCLIAdapter = _loadAdapter();
    const adapter = new AnthropicCLIAdapter();
    await assert.rejects(
      () => adapter.complete({ prompt: "x", model: "m", maxOutputTokens: 100, timeoutMs: 300 }),
      /claude killed \(SIGKILL\) — timeout\?/,
    );

    let grandchildPid = null;
    for (let i = 0; i < 20 && grandchildPid === null; i++) {
      if (fs.existsSync(pidFile)) {
        const raw = fs.readFileSync(pidFile, "utf8").trim();
        if (raw) grandchildPid = parseInt(raw, 10);
      }
      if (grandchildPid === null) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(grandchildPid, "expected grandchild pid to be recorded by fake CLI script");

    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((r) => setTimeout(r, 100));
      } catch (_e) {
        alive = false;
      }
    }
    assert.equal(alive, false, "grandchild process must be killed along with the process group");
  } finally {
    if (origBin === undefined) delete process.env.CLAUDE_CLI_BIN; else process.env.CLAUDE_CLI_BIN = origBin;
    if (origPidFile === undefined) delete process.env.PIDFILE; else process.env.PIDFILE = origPidFile;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("anthropic-cli: crawler.* skill → slim flags + empty cwd + safety system prompt", async () => {
  const captured = {};
  const stub = _makeStub(["[]"], [], 0, null, captured);
  await _withSpawn(stub, async () => {
    const AnthropicCLIAdapter = _loadAdapter();
    const r = await new AnthropicCLIAdapter().complete({
      prompt: "extract", model: "claude-haiku-4-5", maxOutputTokens: 10,
      skill: "crawler.extract", systemPrompt: "TASK RULES",
      allowedTools: "mcp__CloakBrowser__cloak_launch", mcpConfigPath: "mcp.config.json",
    });
    assert.equal(r.text, "[]");
    const a = captured.argv;
    const sys = a[a.indexOf("--system-prompt") + 1];
    assert.match(sys, /Do NOT log in/);
    assert.match(sys, /TASK RULES$/);
    assert.equal(a[a.indexOf("--tools") + 1], "");
    assert.ok(a.includes("--disable-slash-commands"));
    assert.ok(a.includes("--strict-mcp-config"));
    assert.ok(path.isAbsolute(a[a.indexOf("--mcp-config") + 1]), "mcp path absolute (cwd changes)");
    assert.equal(a[a.indexOf("--allowedTools") + 1], "mcp__CloakBrowser__cloak_launch");
    assert.match(captured.opts.cwd, /ai-gateway-cli-slim$/);
    assert.equal(a[a.length - 1], "extract");
  });
});

test("anthropic-cli: non-crawler skill / AI_GATEWAY_CLI_SLIM=0 → no slim flags, inherited cwd", async () => {
  for (const [skill, env] of [["research.summarize", undefined], ["crawler.login", undefined], ["crawler.extract", "0"]]) {
    const captured = {};
    const prev = process.env.AI_GATEWAY_CLI_SLIM;
    if (env === undefined) delete process.env.AI_GATEWAY_CLI_SLIM; else process.env.AI_GATEWAY_CLI_SLIM = env;
    try {
      await _withSpawn(_makeStub(["ok"], [], 0, null, captured), async () => {
        const AnthropicCLIAdapter = _loadAdapter();
        await new AnthropicCLIAdapter().complete({ prompt: "x", model: "", maxOutputTokens: 1, skill });
      });
    } finally {
      if (prev === undefined) delete process.env.AI_GATEWAY_CLI_SLIM; else process.env.AI_GATEWAY_CLI_SLIM = prev;
    }
    assert.ok(!captured.argv.includes("--system-prompt"), skill);
    assert.ok(!captured.argv.includes("--tools"), skill);
    assert.equal(captured.opts.cwd, undefined, skill);
  }
});
