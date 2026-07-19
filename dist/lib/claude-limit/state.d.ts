/**
 * Record a limit hit for skill. If resetAt null, default to 5h from now.
 */
declare function markLimitHit(skill: string, match: any): void;
/**
 * Check if skill is in cooldown. Returns { skip, resetAt, kind }.
 * If resetAt <= now, entry is expired and removed → skip:false.
 */
declare function shouldSkip(skill: string): {
    skip: boolean;
    resetAt: number | null;
    kind: string | null;
};
/**
 * Clear cooldown for skill (called after successful call).
 */
declare function clearLimit(skill: string): void;
/**
 * List all active (non-expired) limits.
 */
declare function getActiveLimits(): Array<{
    skill: string;
    kind: string;
    resetAt: number;
}>;
declare const _default: {
    markLimitHit: typeof markLimitHit;
    shouldSkip: typeof shouldSkip;
    clearLimit: typeof clearLimit;
    getActiveLimits: typeof getActiveLimits;
};
export = _default;
//# sourceMappingURL=state.d.ts.map