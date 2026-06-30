"use strict";

// claude-limit/state.ts
// In-memory per-skill cooldown tracking (process-level).
// Lost on process restart (acceptable — next cron tick will hit limit again + alert).
// Lazy expiry on read — resetAt > now → skip active; otherwise remove entry.
// If resetAt null (parse fail) → fallback 5h default cooldown.

const COOLDOWN_5H_MS = 5 * 60 * 60 * 1000;

interface LimitEntry {
  kind: string;
  resetAt: number;
  markTime: number;
}

const _limits: Map<string, LimitEntry> = new Map();

/**
 * Record a limit hit for skill. If resetAt null, default to 5h from now.
 */
function markLimitHit(skill: string, match: any): void {
  const resetAt = match.resetAt ?? (Date.now() + COOLDOWN_5H_MS);
  _limits.set(skill, {
    kind: match.kind || "rate_limit",
    resetAt,
    markTime: Date.now(),
  });
}

/**
 * Check if skill is in cooldown. Returns { skip, resetAt, kind }.
 * If resetAt <= now, entry is expired and removed → skip:false.
 */
function shouldSkip(
  skill: string
): { skip: boolean; resetAt: number | null; kind: string | null } {
  const entry = _limits.get(skill);
  if (!entry) return { skip: false, resetAt: null, kind: null };

  const now = Date.now();
  if (entry.resetAt <= now) {
    // Expired — remove and skip=false
    _limits.delete(skill);
    return { skip: false, resetAt: null, kind: null };
  }

  // Still active cooldown
  return { skip: true, resetAt: entry.resetAt, kind: entry.kind };
}

/**
 * Clear cooldown for skill (called after successful call).
 */
function clearLimit(skill: string): void {
  _limits.delete(skill);
}

/**
 * List all active (non-expired) limits.
 */
function getActiveLimits(): Array<{
  skill: string;
  kind: string;
  resetAt: number;
}> {
  const now = Date.now();
  const active: Array<{ skill: string; kind: string; resetAt: number }> = [];
  for (const [skill, entry] of _limits.entries()) {
    if (entry.resetAt > now) {
      active.push({ skill, kind: entry.kind, resetAt: entry.resetAt });
    }
  }
  return active;
}

export = { markLimitHit, shouldSkip, clearLimit, getActiveLimits };
