"use strict";

// ai-gateway/rate-limit/circuit-breaker.ts
// L4 — Per-provider circuit breaker. States: closed | open | half-open.
// Trip to OPEN after N consecutive failures within failureWindowMs.
// After cooldownMs in OPEN, allow one probe (HALF_OPEN). Success → CLOSED, fail → OPEN again.

type State = "closed" | "open" | "half-open";

interface BreakerOpts {
  failureThreshold: number;     // consecutive failures to trip
  cooldownMs: number;           // how long to stay open before probe
}

interface BreakerEntry {
  state: State;
  failures: number;
  openedAt: number;
}

interface GuardResult {
  ok: boolean;
  reason?: string;
}

const DEFAULT_OPTS: BreakerOpts = {
  failureThreshold: 5,
  cooldownMs: 60 * 1000,
};

const _state: Map<string, BreakerEntry> = new Map();

function _get(provider: string): BreakerEntry {
  let e = _state.get(provider);
  if (!e) {
    e = { state: "closed", failures: 0, openedAt: 0 };
    _state.set(provider, e);
  }
  return e;
}

async function guard(provider: string, opts: Partial<BreakerOpts> = {}): Promise<GuardResult> {
  if (!provider) return { ok: false, reason: "no provider" };
  const merged: BreakerOpts = { ...DEFAULT_OPTS, ...opts };
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

function recordSuccess(provider: string): void {
  const e = _get(provider);
  e.failures = 0;
  e.state = "closed";
  e.openedAt = 0;
}

function recordFailure(provider: string, opts: Partial<BreakerOpts> = {}): void {
  const merged: BreakerOpts = { ...DEFAULT_OPTS, ...opts };
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

function _reset(): void {
  _state.clear();
}

function _state_of(provider: string): State {
  return _get(provider).state;
}

export = { guard, recordSuccess, recordFailure, _reset, _state_of };
