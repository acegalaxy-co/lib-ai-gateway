"use strict";
const DEFAULT_OPTS = {
    failureThreshold: 5,
    cooldownMs: 60 * 1000,
};
const _state = new Map();
function _get(provider) {
    let e = _state.get(provider);
    if (!e) {
        e = { state: "closed", failures: 0, openedAt: 0 };
        _state.set(provider, e);
    }
    return e;
}
async function guard(provider, opts = {}) {
    if (!provider)
        return { ok: false, reason: "no provider" };
    const merged = { ...DEFAULT_OPTS, ...opts };
    const e = _get(provider);
    if (e.state === "open") {
        const elapsed = Date.now() - e.openedAt;
        if (elapsed < merged.cooldownMs) {
            return { ok: false, reason: "L4_circuit_open" };
        }
        // Cooldown elapsed → probe.
        e.state = "half-open";
    }
    return { ok: true };
}
function recordSuccess(provider) {
    const e = _get(provider);
    e.failures = 0;
    e.state = "closed";
    e.openedAt = 0;
}
function recordFailure(provider, opts = {}) {
    const merged = { ...DEFAULT_OPTS, ...opts };
    const e = _get(provider);
    e.failures += 1;
    if (e.state === "half-open") {
        // Probe failed → re-open.
        e.state = "open";
        e.openedAt = Date.now();
        return;
    }
    if (e.failures >= merged.failureThreshold) {
        e.state = "open";
        e.openedAt = Date.now();
    }
}
function _reset() {
    _state.clear();
}
function _state_of(provider) {
    return _get(provider).state;
}
module.exports = { guard, recordSuccess, recordFailure, _reset, _state_of };
//# sourceMappingURL=circuit-breaker.js.map