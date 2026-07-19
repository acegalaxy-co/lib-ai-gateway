export type LimitKind = "session_5h" | "weekly_7d" | "rate_limit" | null;
export interface LimitMatch {
    kind: LimitKind;
    resetAt: number | null;
    raw: string;
}
/**
 * Inspect CLI stderr (or any error message) for limit signatures.
 * Returns null when no limit pattern matches — caller treats as generic error.
 */
export declare function detectClaudeLimit(stderr: string | null | undefined): LimitMatch | null;
/**
 * Human-readable label for Alert Nexus messages (Vietnamese).
 */
export declare function limitKindLabel(kind: LimitKind): string;
//# sourceMappingURL=detect.d.ts.map