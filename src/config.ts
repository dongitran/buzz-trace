/**
 * Configuration and environment auto-detection for buzz-trace.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ConfigOptions {
  endpoint?: string;
  project?: string;
  dbPath?: string;
  timeout?: number;
  showSecrets?: boolean;
}

export class Config {
  endpoint: string;
  project: string;
  dbPath: string | null;
  timeout: number;
  showSecrets: boolean;

  constructor(options: ConfigOptions = {}) {
    let resolvedEndpoint =
      options.endpoint ||
      process.env.PHOENIX_ENDPOINT ||
      process.env.PHOENIX_COLLECTOR_ENDPOINT ||
      "http://localhost:6006";

    // Normalize endpoint (strip trailing slashes and /v1 suffix)
    resolvedEndpoint = resolvedEndpoint.replace(/\/+$/, "");
    if (resolvedEndpoint.endsWith("/v1")) {
      resolvedEndpoint = resolvedEndpoint.slice(0, -3);
    }

    this.endpoint = resolvedEndpoint;
    this.project = options.project || process.env.PHOENIX_PROJECT || "mobile";
    this.timeout = options.timeout ?? 10000;
    this.showSecrets = options.showSecrets ?? false;

    // Resolve SQLite DB path
    let resolvedDb = options.dbPath || process.env.PHOENIX_DB_PATH || null;
    if (!resolvedDb) {
      const candidates = [
        "/root/.phoenix/phoenix.db",
        path.join(os.homedir(), ".phoenix", "phoenix.db"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          resolvedDb = candidate;
          break;
        }
      }
    }
    this.dbPath = resolvedDb;
  }

  static load(options: ConfigOptions = {}): Config {
    return new Config(options);
  }
}
