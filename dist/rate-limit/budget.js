"use strict";
const WINDOW_MS = 24 * 60 * 60 * 1000;
const _buckets = new Map();
const _reservations = new Map();
let _reservationCounter = 0;
function _sumWindow(skill) {
    const arr = _buckets.get(skill);
    if (!arr)
        return 0;
    const cutoff = Date.now() - WINDOW_MS;
    // Drop old entries in-place.
    let i = 0;
    while (i < arr.length && arr[i].ts < cutoff)
        i += 1;
    if (i > 0)
        arr.splice(0, i);
    let sum = 0;
    for (const e of arr)
        sum += e.tokens;
    return sum;
}
async function reserve(skill, estimatedTokens, dailyTokenQuota) {
    if (!skill)
        return { ok: false, reason: "no skill" };
    if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
        return { ok: false, reason: "invalid estimate" };
    }
    if (!Number.isFinite(dailyTokenQuota) || dailyTokenQuota <= 0) {
        return { ok: false, reason: "invalid quota" };
    }
    const spent = _sumWindow(skill);
    if (spent + estimatedTokens > dailyTokenQuota) {
        return { ok: false, reason: "L3_budget_exhausted" };
    }
    _reservationCounter += 1;
    const reservationId = `r_${_reservationCounter}_${skill}`;
    _reservations.set(reservationId, { skill, tokens: estimatedTokens });
    // Pre-write estimate so concurrent reserves are aware.
    let arr = _buckets.get(skill);
    if (!arr) {
        arr = [];
        _buckets.set(skill, arr);
    }
    arr.push({ ts: Date.now(), tokens: estimatedTokens });
    return { ok: true, reservationId };
}
async function commit(reservationId, actualTokens) {
    const r = _reservations.get(reservationId);
    if (!r)
        return;
    _reservations.delete(reservationId);
    // Reconcile: subtract estimate, add actual.
    const arr = _buckets.get(r.skill);
    if (!arr)
        return;
    // Replace the most recent matching estimate with actual.
    for (let i = arr.length - 1; i >= 0; i -= 1) {
        if (arr[i].tokens === r.tokens) {
            arr[i].tokens = Math.max(0, actualTokens);
            return;
        }
    }
}
async function refund(reservationId) {
    // Called when call fails before adapter — release estimate.
    const r = _reservations.get(reservationId);
    if (!r)
        return;
    _reservations.delete(reservationId);
    const arr = _buckets.get(r.skill);
    if (!arr)
        return;
    for (let i = arr.length - 1; i >= 0; i -= 1) {
        if (arr[i].tokens === r.tokens) {
            arr.splice(i, 1);
            return;
        }
    }
}
function _reset() {
    _buckets.clear();
    _reservations.clear();
    _reservationCounter = 0;
}
function _spent(skill) {
    return _sumWindow(skill);
}
module.exports = { reserve, commit, refund, _reset, _spent, WINDOW_MS };
//# sourceMappingURL=budget.js.map