/**
 * Configuration and environment auto-detection for buzz-trace.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ConfigOptions {
  endpoint?: string;
  uiEndpoint?: string;
  project?: string;
  dbPath?: string;
  timeout?: number;
  showSecrets?: boolean;
  /** A Phoenix API key, for a server that has authentication on. Falls back to PHOENIX_API_KEY. */
  apiKey?: string;
  /** A file (or `-` for stdin) holding the relay's thread as `buzz messages thread --format json` prints it. */
  messagesPath?: string;
}

export class Config {
  endpoint: string;
  uiEndpoint: string;
  project: string;
  dbPath: string | null;
  timeout: number;
  showSecrets: boolean;
  messagesPath: string | null;
  /** Never enumerable, so serializing or logging a Config cannot print it. */
  declare readonly apiKey: string | null;

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

    let resolvedUi =
      options.uiEndpoint ||
      process.env.PHOENIX_UI_ENDPOINT ||
      this.endpoint;
    resolvedUi = resolvedUi.replace(/\/+$/, "");
    if (resolvedUi.endsWith("/v1")) {
      resolvedUi = resolvedUi.slice(0, -3);
    }
    this.uiEndpoint = resolvedUi;

    this.project = options.project || process.env.PHOENIX_PROJECT || "mobile";
    this.timeout = options.timeout ?? 10000;
    this.showSecrets = options.showSecrets ?? false;
    this.messagesPath = options.messagesPath ?? null;
    Object.defineProperty(this, "apiKey", {
      value: options.apiKey || process.env.PHOENIX_API_KEY || null,
      enumerable: false,
    });

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

  /**
   * A thread's page in the Phoenix UI. Phoenix routes a project by its global id, not its name, so the link goes through
   * the redirect that finds the session by the id the spans carry (the thread root).
   */
  getSessionUrl(sessionId: string | null, threadId?: string): string {
    const id = sessionId || threadId || "";
    return `${this.uiEndpoint}/redirects/sessions/${encodeURIComponent(id)}`;
  }

  /** One turn's trace page, through the redirect that finds the trace by its id. */
  getTraceUrl(traceId: string): string {
    return `${this.uiEndpoint}/redirects/traces/${encodeURIComponent(traceId)}`;
  }

  static load(options: ConfigOptions = {}): Config {
    return new Config(options);
  }
}
