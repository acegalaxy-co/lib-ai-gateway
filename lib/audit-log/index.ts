"use strict";

import fs = require("fs");
import fsp = require("fs/promises");

interface AuditLoggerOpts {
  logPath: string;
  tag: string;
  mode?: "sync" | "async";
}

interface AuditLogger {
  record: (rec: Record<string, unknown>) => Promise<void>;
  LOG_PATH: string;
}

function createAuditLogger({ logPath, tag, mode = "sync" }: AuditLoggerOpts = {} as AuditLoggerOpts): AuditLogger {
  if (!logPath) throw new Error("createAuditLogger: logPath required");
  if (!tag) throw new Error("createAuditLogger: tag required");
  if (mode !== "sync" && mode !== "async") {
    throw new Error(`createAuditLogger: invalid mode '${mode}' (expected 'sync' | 'async')`);
  }

  async function record(rec: Record<string, unknown>): Promise<void> {
    try {
      const line = JSON.stringify(rec) + "\n";
      if (mode === "sync") {
        fs.appendFileSync(logPath, line, { encoding: "utf8" });
      } else {
        await fsp.appendFile(logPath, line, { encoding: "utf8" });
      }
    } catch (err: unknown) {
      // Audit must never break the main flow. Fall back to stderr.
      // eslint-disable-next-line no-console
      console.error(`[${tag}] failed to write:`, err && (err as Error).message);
    }
  }

  return { record, LOG_PATH: logPath };
}

export = { createAuditLogger };