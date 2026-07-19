"use strict";

// claude-limit/alert.ts
// Rate-limited Telegram alerts to Alert Nexus channel on Claude CLI limit hit.
// Tracks 1x per scheduler:kind per 1h to prevent spam.

const path = require("node:path");

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Internal Map<key="scheduler:kind", lastAlertTime>
const _alertTimes: Map<string, number> = new Map();

// Resolve Nexus repo root from __dirname. This file runs from either
// commons/ai-gateway/lib/claude-limit (tsx source) or
// commons/ai-gateway/dist/lib/claude-limit (compiled) — the dist/ level shifts
// the relative depth, so a hardcoded "../../.." breaks in one of them (the
// old 6-up string was wrong for both → "Cannot find module", alerts silent).
// Anchor on the "commons" path segment instead: robust to dist nesting.
function _repoRoot(): string {
  const parts = __dirname.split(path.sep);
  const i = parts.lastIndexOf("commons");
  return i > 0
    ? parts.slice(0, i).join(path.sep)
    : path.join(__dirname, "..", "..", "..", "..");
}

/**
 * Send alert to Telegram if enough time has passed since last alert for this scheduler:kind.
 * Does NOT throw — swallows Telegram API errors.
 */
async function alertClaudeCliLimit(
  schedulerName: string,
  skill: string,
  kind: string | null,
  resetAt: number | null
): Promise<void> {
  const key = `${schedulerName}:${kind || "unknown"}`;
  const now = Date.now();
  const lastAlert = _alertTimes.get(key) || 0;

  if (now < lastAlert + ALERT_COOLDOWN_MS) {
    // Still in cooldown — skip alert
    console.log(
      `[ai-gateway][claude-limit-alert] Skipping alert for ${key} (cooldown active, last ${((now - lastAlert) / 1000).toFixed(0)}s ago)`
    );
    return;
  }

  // Update cooldown marker
  _alertTimes.set(key, now);

  const resetLabel = resetAt ? new Date(resetAt).toISOString() : "unknown";
  const message = `🚦 **CLAUDE CLI LIMIT** — Scheduler: ${schedulerName}\nSkill: ${skill}\nKind: ${kind || "rate-limit"}\nReset: ${resetLabel}\n\nScheduler paused until reset.`;

  try {
    // Resolve from repo root (robust to dist/ vs src nesting — see _repoRoot).
    const notify = require(
      path.join(_repoRoot(), "src", "app", "modules", "shared", "telegram")
    );
    const channelId = process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;

    if (!channelId) {
      console.warn(
        "[ai-gateway][claude-limit-alert] NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT not set; skipping alert"
      );
      return;
    }

    // Send async without awaiting (fire-and-forget).
    // sendTelegram(text, chatId, options) — text first, chatId second.
    notify
      .sendTelegram(message, channelId)
      .catch((e: any) => {
        console.error(
          "[ai-gateway][claude-limit-alert] Telegram send failed:",
          e && (e as Error).message
        );
      });

    console.log(
      `[ai-gateway][claude-limit-alert] Alert queued for ${key}: ${resetLabel}`
    );
  } catch (e: any) {
    console.error(
      "[ai-gateway][claude-limit-alert] Failed to send alert:",
      e && (e as Error).message
    );
  }
}

// For testing: clear alert cooldown
function _clearAlertCooldown(schedulerName: string, kind: string): void {
  const key = `${schedulerName}:${kind || "unknown"}`;
  _alertTimes.delete(key);
}

export = { alertClaudeCliLimit, _clearAlertCooldown };
