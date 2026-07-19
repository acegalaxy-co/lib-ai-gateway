type State = "closed" | "open" | "half-open";
interface BreakerOpts {
    failureThreshold: number;
    cooldownMs: number;
}
interface GuardResult {
    ok: boolean;
    reason?: string;
}
declare function guard(provider: string, opts?: Partial<BreakerOpts>): Promise<GuardResult>;
declare function recordSuccess(provider: string): void;
declare function recordFailure(provider: string, opts?: Partial<BreakerOpts>): void;
declare function _reset(): void;
declare function _state_of(provider: string): State;
declare const _default: {
    guard: typeof guard;
    recordSuccess: typeof recordSuccess;
    recordFailure: typeof recordFailure;
    _reset: typeof _reset;
    _state_of: typeof _state_of;
};
export = _default;
//# sourceMappingURL=circuit-breaker.d.ts.map