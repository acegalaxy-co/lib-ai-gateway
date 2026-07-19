"use strict";
const fs = require("fs");
const fsp = require("fs/promises");
function createAuditLogger({ logPath, tag, mode = "sync" } = {}) {
    if (!logPath)
        throw new Error("createAuditLogger: logPath required");
    if (!tag)
        throw new Error("createAuditLogger: tag required");
    if (mode !== "sync" && mode !== "async") {
        throw new Error(`createAuditLogger: invalid mode '${mode}' (expected 'sync' | 'async')`);
    }
    async function record(rec) {
        try {
            const line = JSON.stringify(rec) + "\n";
            if (mode === "sync") {
                fs.appendFileSync(logPath, line, { encoding: "utf8" });
            }
            else {
                await fsp.appendFile(logPath, line, { encoding: "utf8" });
            }
        }
        catch (err) {
            // Audit must never break the main flow. Fall back to stderr.
            // eslint-disable-next-line no-console
            console.error(`[${tag}] failed to write:`, err && err.message);
        }
    }
    return { record, LOG_PATH: logPath };
}
module.exports = { createAuditLogger };
//# sourceMappingURL=index.js.map