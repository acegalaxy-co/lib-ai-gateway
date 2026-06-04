"use strict";

// ai-gateway/rate-limit/budget.ts
// L3 — Token budget per skill, rolling 24h window. In-process counter.
// Reserve estimated tokens pre-call; commit/refund actual delta post-call.
// (PM2 restart resets counters — fine for Phase 1; persist to redis/file in Phase 2.)

interface ReserveResult {
  ok: boolean;
  reason?: string;
  reservationId?: string;
}

interface BucketEntry {
  ts: number;
  tokens: number;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

const _buckets: Map<string, BucketEntry[]> = new Map();
const _reservations: Map<string, { skill: string; tokens: number }> = new Map();
let _reservationCounter = 0;

function _sumWindow(skill: string): number {
  const arr = _buckets.get(skill);
  if (!arr) return 0;
  const cutoff = Date.now() - WINDOW_MS;
  // Drop old entries in-place.
  let i = 0;
  while (i < arr.length && arr[i].ts < cutoff) i += 1;
  if (i > 0) arr.splice(0, i);
  let sum = 0;
  for (const e of arr) sum += e.tokens;
  return sum;
}

async function reserve(skill: string, estimatedTokens: number, dailyTokenQuota: number): Promise<ReserveResult> {
  if (!skill) return { ok: false, reason: "no skill" };
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

async function commit(reservationId: string, actualTokens: number): Promise<void> {
  const r = _reservations.get(reservationId);
  if (!r) return;
  _reservations.delete(reservationId);
  // Reconcile: subtract estimate, add actual.
  const arr = _buckets.get(r.skill);
  if (!arr) return;
  // Replace the most recent matching estimate with actual.
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i].tokens === r.tokens) {
      arr[i].tokens = Math.max(0, actualTokens);
      return;
    }
  }
}

async function refund(reservationId: string): Promise<void> {
  // Called when call fails before adapter — release estimate.
  const r = _reservations.get(reservationId);
  if (!r) return;
  _reservations.delete(reservationId);
  const arr = _buckets.get(r.skill);
  if (!arr) return;
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i].tokens === r.tokens) {
      arr.splice(i, 1);
      return;
    }
  }
}

function _reset(): void {
  _buckets.clear();
  _reservations.clear();
  _reservationCounter = 0;
}

function _spent(skill: string): number {
  return _sumWindow(skill);
}

export = { reserve, commit, refund, _reset, _spent, WINDOW_MS };
