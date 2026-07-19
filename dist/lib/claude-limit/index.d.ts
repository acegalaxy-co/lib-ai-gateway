import detect = require("./detect");
declare const _default: {
    alertClaudeCliLimit: (schedulerName: string, skill: string, kind: string | null, resetAt: number | null, sendAlert: (message: string, channelId: string) => Promise<void> | void) => Promise<void>;
    _clearAlertCooldown: (schedulerName: string, kind: string) => void;
    ClaudeCliLimitError: {
        new (skill: string, match: any): {
            kind: string | null;
            resetAt: number | null;
            skill: string;
            raw: string;
            isClaudeCliLimit: boolean;
            name: string;
            message: string;
            stack?: string;
            cause?: unknown;
        };
        captureStackTrace(targetObject: object, constructorOpt?: Function): void;
        prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
        stackTraceLimit: number;
    };
    markLimitHit: (skill: string, match: any) => void;
    shouldSkip: (skill: string) => {
        skip: boolean;
        resetAt: number | null;
        kind: string | null;
    };
    clearLimit: (skill: string) => void;
    getActiveLimits: () => Array<{
        skill: string;
        kind: string;
        resetAt: number;
    }>;
    detectClaudeLimit(stderr: string | null | undefined): detect.LimitMatch | null;
    limitKindLabel(kind: detect.LimitKind): string;
};
export = _default;
//# sourceMappingURL=index.d.ts.map