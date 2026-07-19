interface AuditLoggerOpts {
    logPath: string;
    tag: string;
    mode?: "sync" | "async";
}
interface AuditLogger {
    record: (rec: Record<string, unknown>) => Promise<void>;
    LOG_PATH: string;
}
declare function createAuditLogger({ logPath, tag, mode }?: AuditLoggerOpts): AuditLogger;
declare const _default: {
    createAuditLogger: typeof createAuditLogger;
};
export = _default;
//# sourceMappingURL=index.d.ts.map