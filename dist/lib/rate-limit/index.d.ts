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
declare function createSlidingWindow({ windowMs, maxRequests, keyFn, reasonOnDeny, extraChecks, }?: SlidingWindowOpts): SlidingWindowLimiter;
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
declare function createReplayGuard({ ttlMs }?: ReplayGuardOpts): ReplayGuard;
declare const _default: {
    createSlidingWindow: typeof createSlidingWindow;
    createReplayGuard: typeof createReplayGuard;
};
export = _default;
//# sourceMappingURL=index.d.ts.map