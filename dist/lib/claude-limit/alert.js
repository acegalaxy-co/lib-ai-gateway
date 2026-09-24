"use strict";
// claude-limit/alert.ts
// Rate-limited alerts on Claude CLI limit hit. Tracks 1x per scheduler:kind
// per 1h to prevent spam.
//
// Transport is INJECTED by the caller (dependency injection) — the gateway is
// a standalone shared package (@acegalaxy/lib-ai-gateway) and must NOT reach into
// the consumer app to resolve a telegram/notify module. The caller passes
// `sendAlert(message, channelId)`; here we only decide cooldown + build the
// message + read the channel env, then hand off.
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
// Internal Map<key="scheduler:kind", lastAlertTime>
const _alertTimes = new Map();
/**
 * Send alert via the injected transport if enough time has passed since last
 * alert for this scheduler:kind. Does NOT throw — swallows transport errors and
 * a missing/invalid `sendAlert` (defensive: old callers that omit it won't crash).
 */
async function alertClaudeCliLimit(schedulerName, skill, kind, resetAt, sendAlert) {
    const key = `${schedulerName}:${kind || "unknown"}`;
    const now = Date.now();
    const lastAlert = _alertTimes.get(key) || 0;
    if (now < lastAlert + ALERT_COOLDOWN_MS) {
        // Still in cooldown — skip alert
        console.log(`[ai-gateway][claude-limit-alert] Skipping alert for ${key} (cooldown active, last ${((now - lastAlert) / 1000).toFixed(0)}s ago)`);
        return;
    }
    const channelId = process.env.NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT;
    if (!channelId) {
        console.warn("[ai-gateway][claude-limit-alert] NEXUS_TELEGRAM_CHANNEL_STATUS_ALERT not set; skipping alert");
        return;
    }
    if (typeof sendAlert !== "function") {
        console.warn("[ai-gateway][claude-limit-alert] no sendAlert transport injected; skipping alert");
        return;
    }
    // Update cooldown marker only once we know we can actually send.
    _alertTimes.set(key, now);
    const resetLabel = resetAt ? new Date(resetAt).toISOString() : "unknown";
    const message = `🚦 **CLAUDE CLI LIMIT** — Scheduler: ${schedulerName}\nSkill: ${skill}\nKind: ${kind || "rate-limit"}\nReset: ${resetLabel}\n\nScheduler paused until reset.`;
    try {
        // Fire-and-forget via injected transport. sendAlert(message, channelId) —
        // message first, channelId second (same order as the old telegram call).
        await Promise.resolve(sendAlert(message, channelId));
        console.log(`[ai-gateway][claude-limit-alert] Alert queued for ${key}: ${resetLabel}`);
    }
    catch (e) {
        console.error("[ai-gateway][claude-limit-alert] Failed to send alert:", e && e.message);
    }
}
// For testing: clear alert cooldown
function _clearAlertCooldown(schedulerName, kind) {
    const key = `${schedulerName}:${kind || "unknown"}`;
    _alertTimes.delete(key);
}
module.exports = { alertClaudeCliLimit, _clearAlertCooldown };
//# sourceMappingURL=alert.js.map