type SendAlertFn = (message: string, channelId: string) => Promise<void> | void;
/**
 * Send alert via the injected transport if enough time has passed since last
 * alert for this scheduler:kind. Does NOT throw — swallows transport errors and
 * a missing/invalid `sendAlert` (defensive: old callers that omit it won't crash).
 */
declare function alertClaudeCliLimit(schedulerName: string, skill: string, kind: string | null, resetAt: number | null, sendAlert: SendAlertFn): Promise<void>;
declare function _clearAlertCooldown(schedulerName: string, kind: string): void;
declare const _default: {
    alertClaudeCliLimit: typeof alertClaudeCliLimit;
    _clearAlertCooldown: typeof _clearAlertCooldown;
};
export = _default;
//# sourceMappingURL=alert.d.ts.map