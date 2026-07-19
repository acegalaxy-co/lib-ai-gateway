"use strict";
/**
 * Create a sliding-window rate limiter.
 *
 * @param {SlidingWindowOpts} opts
 * @returns {SlidingWindowLimiter}
 */
function createSlidingWindow({ windowMs, maxRequests, keyFn = (x) => String(x || ""), reasonOnDeny = "rate_limit", extraChecks = [], } = {}) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
        throw new Error("createSlidingWindow: windowMs must be positive number");
    }
    if (!Number.isFinite(maxRequests) || maxRequests <= 0) {
        throw new Error("createSlidingWindow: maxRequests must be positive number");
    }
    if (typeof keyFn !== "function") {
        throw new Error("createSlidingWindow: keyFn must be function");
    }
    const _buckets = new Map();
    async function check(...args) {
        const key = keyFn(...args);
        if (!key)
            return { ok: false, reason: reasonOnDeny };
        const now = Date.now();
        const cutoff = now - windowMs;
        let arr = _buckets.get(key);
        if (!arr) {
            arr = [];
            _buckets.set(key, arr);
        }
        // Drop old entries (in-place).
        let i = 0;
        while (i < arr.length && arr[i] < cutoff)
            i += 1;
        if (i > 0)
            arr.splice(0, i);
        if (arr.length >= maxRequests) {
            return { ok: false, reason: reasonOnDeny };
        }
        arr.push(now);
        // Run extra checks (e.g. cost cap). First {ok:false} short-circuits.
        for (const xc of extraChecks) {
            const result = await xc(key, ...args);
            if (result && result.ok === false)
                return result;
        }
        return { ok: true };
    }
    function reset() {
        _buckets.clear();
    }
    return { check, reset, windowMs, maxRequests };
}
/**
 * Create a replay-guard (TTL dedup by id). Used by ott-gateway to prevent
 * processing the same Telegram message twice within the TTL window.
 *
 * @param {ReplayGuardOpts} opts
 * @returns {ReplayGuard}
 */
function createReplayGuard({ ttlMs } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new Error("createReplayGuard: ttlMs must be positive number");
    }
    const _seen = new Map();
    function _gc(now) {
        if (_seen.size <= 1024)
            return;
        for (const [k, v] of _seen) {
            if (now - v > ttlMs)
                _seen.delete(k);
        }
    }
    function seen(id) {
        if (!id)
            return false;
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
    function reset() {
        _seen.clear();
    }
    return { seen, reset };
}
module.exports = { createSlidingWindow, createReplayGuard };
//# sourceMappingURL=index.js.map