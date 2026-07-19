"use strict";

// commons/ai-gateway/test/claude-limit-alert.test.js
// Guards the two PROD bugs (2026-07-19) that made Claude-CLI-limit alerts
// silent ("Cannot find module ...src/app/modules/shared/telegram"):
//   1. require path resolved wrong (dist/ nesting) → module not found.
//   2. sendTelegram called with args swapped (channelId, message).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const ALERT_PATH = path.join(
  __dirname, "..", "dist", "lib", "claude-limit", "alert.js"
);

function _loadAlert() {
  delete require.cache[require.resolve(ALERT_PATH)];
  return require(ALERT_PATH);
}

// Intercept the telegram require; capture the id passed + sendTelegram args.
function _withTelegramStub(capture, fn) {
  const orig = Module.prototype.require;
  Module.prototype.require = function _req(id) {
    if (/shared[\\/]telegram$/.test(String(id))) {
      capture.requireId = id;
      return {
        sendTelegram: (text, chatId) => {
          capture.text = text;
          capture.chatId = chatId;
          return Promise.resolve();
        },
      };
    }
    return orig.apply(this, arguments);
  };
  return Promise.resolve().then(fn).finally(() => {
    Module.prototype.require = orig;
  });
}

test("alertClaudeCliLimit: resolves real telegram path + correct arg order", async () => {
  const prev = process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
  process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = "-100999";
  const cap = {};
  try {
    await _withTelegramStub(cap, async () => {
      const { alertClaudeCliLimit, _clearAlertCooldown } = _loadAlert();
      _clearAlertCooldown("test-sched", "session_5h");
      await alertClaudeCliLimit("test-sched", "invoice-enrich.classify", "session_5h", Date.now());
    });

    // Bug 1: resolved id must point at the REAL telegram source (path correct).
    assert.ok(cap.requireId, "telegram module must be require()d");
    assert.ok(
      path.isAbsolute(cap.requireId),
      "require id should be an absolute repo-root path"
    );
    assert.ok(
      fs.existsSync(cap.requireId + ".ts") || fs.existsSync(cap.requireId + ".js"),
      `resolved telegram path must exist on disk: ${cap.requireId}`
    );

    // Bug 2: sendTelegram(text, chatId) — text is the message, chatId the channel.
    assert.equal(cap.chatId, "-100999", "chatId must be the channel id (2nd arg)");
    assert.match(cap.text, /CLAUDE CLI LIMIT/, "text (1st arg) must be the message body");
  } finally {
    if (prev === undefined) delete process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
    else process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = prev;
  }
});

test("alertClaudeCliLimit: no channel env → skips without throwing", async () => {
  const prev = process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
  delete process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
  const cap = {};
  try {
    await _withTelegramStub(cap, async () => {
      const { alertClaudeCliLimit, _clearAlertCooldown } = _loadAlert();
      _clearAlertCooldown("s2", "weekly_7d");
      await alertClaudeCliLimit("s2", "skill", "weekly_7d", null);
    });
    assert.equal(cap.text, undefined, "sendTelegram must not fire without channel id");
  } finally {
    if (prev !== undefined) process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = prev;
  }
});
