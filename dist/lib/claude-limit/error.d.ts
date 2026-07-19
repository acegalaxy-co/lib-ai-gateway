declare class ClaudeCliLimitError extends Error {
    kind: string | null;
    resetAt: number | null;
    skill: string;
    raw: string;
    isClaudeCliLimit: boolean;
    constructor(skill: string, match: any);
}
declare const _default: {
    ClaudeCliLimitError: typeof ClaudeCliLimitError;
};
export = _default;
//# sourceMappingURL=error.d.ts.map