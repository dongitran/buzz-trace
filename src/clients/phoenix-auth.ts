/**
 * Authentication against a Phoenix that has it switched on.
 *
 * - An API key goes first: `Authorization: Bearer <key>` on every request. If Phoenix refuses it and an email and password
 *   are set, the session below takes over.
 * - Without a key, an email and a password sign in once (`POST /auth/login` answers 204 and sets the cookies
 *   `phoenix-access-token`, valid for ten minutes, and `phoenix-refresh-token`, valid for a week). The access token is then
 *   sent as `Authorization: Bearer`. When a request is refused, the session is refreshed (`POST /auth/refresh`, which rotates
 *   the refresh token) or, if that is refused too, signed in again.
 * - With neither, nothing is sent, which is right for a Phoenix without authentication.
 *
 * Credentials live in private fields: they cannot be enumerated, inspected or serialized by accident. Everything this module
 * says about a failure goes through `redact`, so no credential (nor a token the server set) ends up in an error.
 */

import { PhoenixAPIError } from "./errors.js";

export interface PhoenixCredentials {
  apiKey?: string | null;
  email?: string | null;
  password?: string | null;
}

const ACCESS_COOKIE = "phoenix-access-token";
const REFRESH_COOKIE = "phoenix-refresh-token";
const REDACTED = "[REDACTED]";

type Mode = "api-key" | "login" | "none";

/** Name and value of every cookie a response sets (`Set-Cookie: name=value; Max-Age=…`). */
function setCookies(response: Response): Map<string, string> {
  const out = new Map<string, string>();
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const line of lines) {
    const pair = line.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) {
      out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  return out;
}

export class PhoenixAuth {
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #apiKey: string | null;
  readonly #email: string | null;
  readonly #password: string | null;
  #mode: Mode;
  #access: string | null = null;
  #refresh: string | null = null;
  #pending: Promise<void> | null = null;

  constructor(endpoint: string, timeoutMs: number, credentials: PhoenixCredentials | string | null = null) {
    const c: PhoenixCredentials = typeof credentials === "string" ? { apiKey: credentials } : (credentials ?? {});
    this.#endpoint = endpoint;
    this.#timeoutMs = timeoutMs;
    this.#apiKey = c.apiKey || null;
    this.#email = c.email || null;
    this.#password = c.password || null;
    this.#mode = this.#apiKey ? "api-key" : this.#canSignIn ? "login" : "none";
  }

  get #canSignIn(): boolean {
    return Boolean(this.#email && this.#password);
  }

  /** What the request is authenticated with, for a message: nothing, the API key, or the signed-in session. */
  get mode(): Mode {
    return this.#mode;
  }

  /** The value of the Authorization header to send, signing in first when that is how this client authenticates; null for none. */
  async authorization(): Promise<string | null> {
    if (this.#mode === "login" && !this.#access) {
      await this.#once(() => this.#signIn());
    }
    if (this.#mode === "api-key") {
      return `Bearer ${this.#apiKey}`;
    }
    if (this.#mode === "login" && this.#access) {
      return `Bearer ${this.#access}`;
    }
    return null;
  }

  /**
   * A request was refused with 401 while it carried `used`. Gets a working credential if there is a way to, and says whether
   * the request is worth sending again. Several requests refused together recover once.
   */
  async recover(used: string | null): Promise<boolean> {
    if ((await this.authorization()) !== used) {
      return true;
    }
    if (this.#mode === "login") {
      await this.#once(async () => {
        if (!(await this.#refreshSession())) {
          await this.#signIn();
        }
      });
      return true;
    }
    if (this.#mode === "api-key" && this.#canSignIn) {
      this.#mode = "login";
      try {
        await this.#once(() => this.#signIn());
      } catch (error) {
        if (error instanceof PhoenixAPIError && error.statusCode === 401) {
          throw new PhoenixAPIError(
            "Phoenix rejected the API key, and then PHOENIX_EMAIL and PHOENIX_PASSWORD too. Check them.",
            401,
          );
        }
        throw error;
      }
      return this.#mode === "login";
    }
    return false;
  }

  /** The text with every credential, token and bearer value this client knows of or can recognize taken out. */
  redact(text: string): string {
    let out = text;
    const known = [this.#apiKey, this.#password, this.#email, this.#access, this.#refresh]
      .filter((v): v is string => typeof v === "string" && v.length >= 4)
      .sort((a, b) => b.length - a.length);
    for (const secret of known) {
      out = out.split(secret).join(REDACTED);
    }
    return redactTokens(out);
  }

  async #once(job: () => Promise<void>): Promise<void> {
    if (!this.#pending) {
      this.#pending = job().finally(() => {
        this.#pending = null;
      });
    }
    return this.#pending;
  }

  async #post(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.#endpoint}${path}`, {
        method: "POST",
        ...init,
        headers: { Accept: "application/json", "User-Agent": "buzz-trace", ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new PhoenixAPIError(this.redact(`Connection failed to Phoenix endpoint ${this.#endpoint}: ${msg}`));
    }
  }

  /** POST /auth/login. A Phoenix without that route has no authentication: nothing to send from then on. */
  async #signIn(): Promise<void> {
    const response = await this.#post("/auth/login", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.#email, password: this.#password }),
    });
    if (response.status === 404 || response.status === 405) {
      this.#mode = "none";
      return;
    }
    if (response.status === 429) {
      const wait = response.headers.get("retry-after");
      throw new PhoenixAPIError(
        `Phoenix is rate-limiting sign-ins${wait ? `: try again in ${wait} s` : ""}. An API key (PHOENIX_API_KEY) needs no sign-in and is the way to run buzz-trace repeatedly.`,
        429,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new PhoenixAPIError("Phoenix rejected PHOENIX_EMAIL and PHOENIX_PASSWORD (invalid email and/or password).", 401);
    }
    if (!response.ok) {
      throw new PhoenixAPIError(`Sign-in to Phoenix at ${this.#endpoint} failed: HTTP ${response.status}.`, response.status);
    }
    const cookies = setCookies(response);
    const access = cookies.get(ACCESS_COOKIE);
    if (!access) {
      throw new PhoenixAPIError(`Phoenix at ${this.#endpoint} accepted the sign-in but set no access token.`, response.status);
    }
    this.#access = access;
    this.#refresh = cookies.get(REFRESH_COOKIE) ?? null;
  }

  /** POST /auth/refresh with the refresh token. It is rotated: the one just used no longer works. */
  async #refreshSession(): Promise<boolean> {
    if (!this.#refresh) {
      return false;
    }
    const cookie = `${REFRESH_COOKIE}=${this.#refresh}${this.#access ? `; ${ACCESS_COOKIE}=${this.#access}` : ""}`;
    const response = await this.#post("/auth/refresh", { headers: { Cookie: cookie } });
    if (!response.ok) {
      this.#access = null;
      this.#refresh = null;
      return false;
    }
    const cookies = setCookies(response);
    const access = cookies.get(ACCESS_COOKIE);
    if (!access) {
      this.#access = null;
      this.#refresh = null;
      return false;
    }
    this.#access = access;
    this.#refresh = cookies.get(REFRESH_COOKIE) ?? null;
    return true;
  }
}

/** Bearer values, JWTs and Phoenix's token cookies, whoever put them in a text. */
export function redactTokens(text: string): string {
  return text
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, REDACTED)
    .replace(/(phoenix-(?:access|refresh)-token)=[^;\s]+/gi, `$1=${REDACTED}`);
}
