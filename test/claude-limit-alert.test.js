"use strict";

// commons/ai-gateway/test/claude-limit-alert.test.js
// alertClaudeCliLimit uses dependency injection for the transport (2026-07-19):
// the caller passes sendAlert(message, channelId); the gateway no longer
// resolves the consumer's telegram module via repo-root walk-up. These guards:
//   1. transport receives (message, channelId) — arg order + channel from env.
//   2. cooldown 1x per scheduler:kind per 1h.
//   3. missing channel env → no send, no throw.
//   4. transport missing/throwing → no throw (fire-and-forget).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ALERT_PATH = path.join(
  __dirname, "..", "dist", "lib", "claude-limit", "alert.js"
);

function _loadAlert() {
  delete require.cache[require.resolve(ALERT_PATH)];
  return require(ALERT_PATH);
}

test("alertClaudeCliLimit: injected transport gets (message, channelId) in order", async () => {
  const prev = process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
  process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = "-100999";
  const got = {};
  try {
    const { alertClaudeCliLimit, _clearAlertCooldown } = _loadAlert();
    _clearAlertCooldown("test-sched", "session_5h");
    await alertClaudeCliLimit(
      "test-sched", "invoice-enrich.classify", "session_5h", Date.now(),
      (message, channelId) => { got.message = message; got.channelId = channelId; }
    );
    assert.equal(got.channelId, "-100999", "channelId must be the 2nd arg (env channel)");
    assert.match(got.message, /CLAUDE CLI LIMIT/, "message (1st arg) must be the body");
    assert.match(got.message, /invoice-enrich\.classify/, "message must include the skill");
  } finally {
    if (prev === undefined) delete process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
    else process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = prev;
  }
});

test("alertClaudeCliLimit: cooldown fires transport only once per scheduler:kind", async () => {
  const prev = process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
  process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = "-100999";
  let calls = 0;
  try {
    const { alertClaudeCliLimit, _clearAlertCooldown } = _loadAlert();
    _clearAlertCooldown("cd-sched", "weekly_7d");
    const send = () => { calls += 1; };
    await alertClaudeCliLimit("cd-sched", "skill", "weekly_7d", null, send);
    await alertClaudeCliLimit("cd-sched", "skill", "weekly_7d", null, send);
    assert.equal(calls, 1, "second call within cooldown must be skipped");
  } finally {
    if (prev === undefined) delete process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
    else process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = prev;
  }
});

test("alertClaudeCliLimit: no channel env → transport not called, no throw", async () => {
  const prev = process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
  delete process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
  let called = false;
  try {
    const { alertClaudeCliLimit, _clearAlertCooldown } = _loadAlert();
    _clearAlertCooldown("s2", "weekly_7d");
    await alertClaudeCliLimit("s2", "skill", "weekly_7d", null, () => { called = true; });
    assert.equal(called, false, "transport must not fire without channel id");
  } finally {
    if (prev !== undefined) process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = prev;
  }
});

test("alertClaudeCliLimit: throwing or missing transport does not throw", async () => {
  const prev = process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
  process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = "-100999";
  try {
    const { alertClaudeCliLimit, _clearAlertCooldown } = _loadAlert();

    // transport that throws → caught, no rejection
    _clearAlertCooldown("throw-sched", "session_5h");
    await alertClaudeCliLimit(
      "throw-sched", "skill", "session_5h", null,
      () => { throw new Error("boom"); }
    );

    // transport omitted (undefined) → defensive skip, no rejection
    _clearAlertCooldown("undef-sched", "session_5h");
    await alertClaudeCliLimit("undef-sched", "skill", "session_5h", null, undefined);

    assert.ok(true, "both calls resolved without throwing");
  } finally {
    if (prev === undefined) delete process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
    else process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT = prev;
  }
});
