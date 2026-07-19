interface CheckResult {
    allow: boolean;
    reason?: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    timeoutMs?: number;
    allowedTools?: string;
    maxOutputTokens?: number;
    dailyTokenQuota?: number;
}
declare function _modelsSource(): "cache" | "config" | "empty";
declare function check(skill: string, tier: string): Promise<CheckResult>;
declare function _reset(): void;
declare const _default: {
    check: typeof check;
    _reset: typeof _reset;
    _modelsSource: typeof _modelsSource;
};
export = _default;
//# sourceMappingURL=engine.d.ts.map