"use strict";

/**
 * @typedef {Object} CheckResult
 * @property {boolean} ok
 * @property {string} [reason]
 */

/**
 * @typedef {Object} SlidingWindowOpts
 * @property {number} windowMs              window size in ms (e.g. 60_000 = 1 min)
 * @property {number} maxRequests           max requests per key per window
 * @property {(...args: unknown[]) => string} [keyFn]  derives key from check() args.
 *                                                 Default: first arg as string.
 * @property {string} [reasonOnDeny="rate_limit"]  reason string when window exceeded
 * @property {Array<(key: string, ...args: unknown[]) => Promise<CheckResult> | CheckResult>} [extraChecks]
 *           additional async/sync checks run AFTER window check passes.
 *           First {ok:false} short-circuits.
 */

/**
 * @typedef {Object} SlidingWindowLimiter
 * @property {(...args: unknown[]) => Promise<CheckResult>} check
 * @property {() => void} reset
 * @property {number} windowMs
 * @property {number} maxRequests
 */

interface CheckResult {
  ok: boolean;
  reason?: string;
}

interface SlidingWindowOpts {
  windowMs: number;
  maxRequests: number;
  keyFn?: (...args: unknown[]) => string;
  reasonOnDeny?: string;
  extraChecks?: Array<(key: string, ...args: unknown[]) => Promise<CheckResult> | CheckResult>;
}

interface SlidingWindowLimiter {
  check: (...args: unknown[]) => Promise<CheckResult>;
  reset: () => void;
  windowMs: number;
  maxRequests: number;
}

/**
 * Create a sliding-window rate limiter.
 *
 * @param {SlidingWindowOpts} opts
 * @returns {SlidingWindowLimiter}
 */
function createSlidingWindow({
  windowMs,
  maxRequests,
  keyFn = (x: unknown) => String(x || ""),
  reasonOnDeny = "rate_limit",
  extraChecks = [],
}: SlidingWindowOpts = {} as SlidingWindowOpts): SlidingWindowLimiter {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("createSlidingWindow: windowMs must be positive number");
  }
  if (!Number.isFinite(maxRequests) || maxRequests <= 0) {
    throw new Error("createSlidingWindow: maxRequests must be positive number");
  }
  if (typeof keyFn !== "function") {
    throw new Error("createSlidingWindow: keyFn must be function");
  }

  const _buckets: Map<string, number[]> = new Map();

  async function check(...args: unknown[]): Promise<CheckResult> {
    const key = keyFn(...args);
    if (!key) return { ok: false, reason: reasonOnDeny };

    const now = Date.now();
    const cutoff = now - windowMs;

    let arr = _buckets.get(key);
    if (!arr) {
      arr = [];
      _buckets.set(key, arr);
    }

    // Drop old entries (in-place).
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i += 1;
    if (i > 0) arr.splice(0, i);

    if (arr.length >= maxRequests) {
      return { ok: false, reason: reasonOnDeny };
    }
    arr.push(now);

    // Run extra checks (e.g. cost cap). First {ok:false} short-circuits.
    for (const xc of extraChecks) {
      const result = await xc(key, ...args);
      if (result && result.ok === false) return result;
    }

    return { ok: true };
  }

  function reset(): void {
    _buckets.clear();
  }

  return { check, reset, windowMs, maxRequests };
}

/**
 * @typedef {Object} ReplayGuardOpts
 * @property {number} ttlMs  how long to remember a seen id (e.g. 5 min)
 *
 * @typedef {Object} ReplayGuard
 * @property {(id: string) => boolean} seen  true if id was already seen within ttl
 *                                            (and refreshes its timestamp);
 *                                            false if first time (and stores it).
 * @property {() => void} reset
 */

interface ReplayGuardOpts {
  ttlMs: number;
}

interface ReplayGuard {
  seen: (id: string) => boolean;
  reset: () => void;
}

/**
 * Create a replay-guard (TTL dedup by id). Used by ott-gateway to prevent
 * processing the same Telegram message twice within the TTL window.
 *
 * @param {ReplayGuardOpts} opts
 * @returns {ReplayGuard}
 */
function createReplayGuard({ ttlMs }: ReplayGuardOpts = {} as ReplayGuardOpts): ReplayGuard {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("createReplayGuard: ttlMs must be positive number");
  }
  const _seen: Map<string, number> = new Map();

  function _gc(now: number): void {
    if (_seen.size <= 1024) return;
    for (const [k, v] of _seen) {
      if (now - v > ttlMs) _seen.delete(k);
    }
  }

  function seen(id: string): boolean {
    if (!id) return false;
    const now = Date.now();
    const prev = _seen.get(id);
    if (prev !== undefined && now - prev <= ttlMs) {
      _seen.set(id, now); // refresh
      return true;
    }
    _seen.set(id, now);
    _gc(now);
    return false;
  }

  function reset(): void {
    _seen.clear();
  }

  return { seen, reset };
}

export = { createSlidingWindow, createReplayGuard };