/**
 * Configuration for buzz-trace: where Phoenix is, with which credentials, and which project.
 *
 * The default source is the live Phoenix. Its endpoint comes from `--endpoint`, `PHOENIX_ENDPOINT`, `PHOENIX_URL`
 * (`PHOENIX_COLLECTOR_ENDPOINT` as a last resort), else http://localhost:6006. The project comes from `--project` or
 * `PHOENIX_PROJECT`; when neither is set it is null and buzz-trace asks Phoenix which project holds the thread, so there is
 * no default project to get wrong. Phoenix's server API is the only source: there is no file to read.
 *
 * Credentials: `--api-key` / `PHOENIX_API_KEY` (Bearer), else `PHOENIX_EMAIL` with `PHOENIX_PASSWORD` (sign-in). They are
 * never enumerable properties, so printing, logging or serializing a Config cannot show them; the password and the email
 * are read from the environment only, never from the command line.
 */

import type { PhoenixCredentials } from "./clients/phoenix-auth.js";

export interface ConfigOptions {
  endpoint?: string;
  uiEndpoint?: string;
  project?: string;
  timeout?: number;
  showSecrets?: boolean;
  /** A Phoenix API key, for a server that has authentication on. Falls back to PHOENIX_API_KEY. */
  apiKey?: string;
}

function trimEndpoint(url: string): string {
  let out = url.replace(/\/+$/, "");
  if (out.endsWith("/v1")) {
    out = out.slice(0, -3);
  }
  return out;
}

export class Config {
  endpoint: string;
  uiEndpoint: string;
  /** The project named by `--project` or `PHOENIX_PROJECT`; null means "find it from the thread". */
  project: string | null;
  timeout: number;
  showSecrets: boolean;
  /** Never enumerable, so serializing or logging a Config cannot print them. */
  declare readonly apiKey: string | null;
  declare readonly email: string | null;
  declare readonly password: string | null;

  constructor(options: ConfigOptions = {}) {
    this.endpoint = trimEndpoint(
      options.endpoint ||
        process.env.PHOENIX_ENDPOINT ||
        process.env.PHOENIX_URL ||
        process.env.PHOENIX_COLLECTOR_ENDPOINT ||
        "http://localhost:6006",
    );
    this.uiEndpoint = trimEndpoint(options.uiEndpoint || process.env.PHOENIX_UI_ENDPOINT || this.endpoint);

    this.project = options.project || process.env.PHOENIX_PROJECT || null;
    this.timeout = options.timeout ?? 30000;
    this.showSecrets = options.showSecrets ?? false;

    const secret = (value: string | null | undefined) => ({ value: value || null, enumerable: false });
    Object.defineProperty(this, "apiKey", secret(options.apiKey || process.env.PHOENIX_API_KEY));
    Object.defineProperty(this, "email", secret(process.env.PHOENIX_EMAIL));
    Object.defineProperty(this, "password", secret(process.env.PHOENIX_PASSWORD));
  }

  /** What the Phoenix client signs in with. */
  credentials(): PhoenixCredentials {
    return { apiKey: this.apiKey, email: this.email, password: this.password };
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
