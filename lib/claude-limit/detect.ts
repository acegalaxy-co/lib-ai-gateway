"use strict";

// claude-limit/detect.ts
// Parse Claude Code CLI stderr to detect Session 5h / Weekly 7d usage limits.
//
// CLI does NOT expose a quota subcommand (verified 2026-06-30 against
// claude 2.1.185). Proactive precheck is not feasible, so we detect
// reactively after spawn() fails with non-zero exit.
//
// Observed stderr signatures (from Anthropic CLI source + community reports):
//   "You've reached your usage limit. Try again at 2026-06-30T19:00:00Z"
//   "Claude usage limit reached. Resets at 2026-07-07T00:00:00Z"
//   "5-hour limit reached"   | "5 hour limit"
//   "weekly limit reached"   | "7-day limit"
//   "Rate limit exceeded. Please try again later."
//
// Conservative parser — when in doubt, classify as UNKNOWN (don't lock cooldown).

type LimitKind = "session_5h" | "weekly_7d" | "rate_limit" | null;

interface LimitMatch {
  kind: LimitKind;
  resetAt: number | null;   // unix ms; null if not parseable from stderr
  raw: string;              // truncated stderr (first 300 chars)
}

const SESSION_KEYWORDS = [
  /5[\s-]?hour\s+limit/i,
  /session\s+limit/i,
];

const WEEKLY_KEYWORDS = [
  /weekly\s+limit/i,
  /7[\s-]?day\s+limit/i,
];

const GENERIC_USAGE_LIMIT = [
  /usage\s+limit/i,
  /rate[\s_]?limit(\s+exceeded|\s+reached)?/i,
  /quota\s+exhausted/i,
];

const RESET_ISO_RE = /(?:try\s+again\s+at|resets?\s+at|reset\s+time)[:\s]+(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i;
const RESET_EPOCH_RE = /reset(?:s|ed)?\s+(?:at\s+)?(\d{10,13})/i;
const RESET_DURATION_RE = /try\s+again\s+in\s+(\d+)\s*(hour|hours|min|minutes|second|seconds)/i;

function _parseResetAt(stderr: string): number | null {
  // 1. ISO timestamp
  const isoMatch = stderr.match(RESET_ISO_RE);
  if (isoMatch && isoMatch[1]) {
    const ts = Date.parse(isoMatch[1].replace(" ", "T"));
    if (!isNaN(ts)) return ts;
  }
  // 2. Unix epoch (seconds or ms)
  const epochMatch = stderr.match(RESET_EPOCH_RE);
  if (epochMatch && epochMatch[1]) {
    const n = parseInt(epochMatch[1], 10);
    if (!isNaN(n)) return n < 1e12 ? n * 1000 : n;
  }
  // 3. Duration ("try again in N hours")
  const durMatch = stderr.match(RESET_DURATION_RE);
  if (durMatch) {
    const n = parseInt(durMatch[1], 10);
    const unit = durMatch[2].toLowerCase();
    const ms = unit.startsWith("hour") ? n * 3600_000
             : unit.startsWith("min")  ? n * 60_000
             : n * 1000;
    return Date.now() + ms;
  }
  return null;
}

/**
 * Inspect CLI stderr (or any error message) for limit signatures.
 * Returns null when no limit pattern matches — caller treats as generic error.
 */
function detectClaudeLimit(stderr: string | null | undefined): LimitMatch | null {
  if (!stderr || typeof stderr !== "string") return null;
  const s = stderr.trim();
  if (!s) return null;

  const isSession = SESSION_KEYWORDS.some(re => re.test(s));
  const isWeekly = WEEKLY_KEYWORDS.some(re => re.test(s));

  let kind: LimitKind = null;
  if (isWeekly) kind = "weekly_7d";          // weekly wins — more restrictive
  else if (isSession) kind = "session_5h";
  else if (GENERIC_USAGE_LIMIT.some(re => re.test(s))) kind = "rate_limit";

  if (!kind) return null;

  return {
    kind,
    resetAt: _parseResetAt(s),
    raw: s.slice(0, 300),
  };
}

/**
 * Human-readable label for Alert Nexus messages (Vietnamese).
 */
function limitKindLabel(kind: LimitKind): string {
  switch (kind) {
    case "session_5h": return "Session (5h)";
    case "weekly_7d":  return "Weekly (7d)";
    case "rate_limit": return "Rate limit chung";
    default:           return "Không xác định";
  }
}

export = { detectClaudeLimit, limitKindLabel };
