/**
 * Arize Phoenix REST API client for buzz-trace, on Node's native fetch (no runtime dependency, no subprocess).
 *
 * What a thread costs: two requests when the project is named: the spans that carry the session id, then every span of those
 * traces (some spans, a steer record for one, need not carry it). When the project is not named it is found first from the
 * session (`GET /v1/sessions/{id}` names the project that holds it), which is two more. Pages are read to the end (the
 * cursor), newest-last (`sort=start_time&order=asc`), so nothing is cut off and tools are listed in the order they ran.
 */

import { SpanNode, SpanNodeData } from "../models.js";
import { PhoenixAPIError } from "./errors.js";
import { PhoenixAuth, type PhoenixCredentials } from "./phoenix-auth.js";

export { PhoenixAPIError } from "./errors.js";
export type { PhoenixCredentials } from "./phoenix-auth.js";

export interface PhoenixSessionTrace {
  id: string;
  trace_id: string;
  start_time: string;
  end_time: string;
}

export interface PhoenixSession {
  id: string;
  session_id: string;
  project_id: string;
  /** The name of the project the session belongs to, when the client could tell (a listing across projects fills it). */
  project_name?: string;
  start_time: string;
  end_time: string;
  traces: PhoenixSessionTrace[];
  token_count_prompt: number;
  token_count_completion: number;
  token_count_total: number;
}

export interface PhoenixProject {
  id: string;
  name: string;
}

/** What looking for a thread found: the project it is in, its spans, every project that was searched, and a hint if it is elsewhere. */
export interface LocatedThread {
  project: string | null;
  spans: SpanNode[];
  searched: string[];
  note?: string;
}

type Params = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

/** The biggest page Phoenix gives. */
const PAGE = 1000;
/** Trace ids per request: the URL stays short. */
const TRACE_CHUNK = 50;
/** A guard against a cursor that never ends. */
const MAX_PAGES = 500;
const SPAN_ORDER = { limit: PAGE, sort: "start_time", order: "asc" } as const;
/** Attributes a message id can be found in, after `session.id`: it started a turn, was replied to, or was posted by a reply call. */
const MESSAGE_ID_ATTRS = ["nostr.thread_id", "nostr.event_id", "nostr.reply_to_id", "nostr.posted_event_id"] as const;
/** A project's global id is base64 of `Project:<n>`. */
const GLOBAL_PROJECT_ID = /^UHJvamVjdDo[A-Za-z0-9+/=]*$/;

/** The session id the spans of a thread carry: its root span's, else any span's. */
function sessionIdOf(spans: SpanNode[]): string | null {
  const ordered = [...spans.filter((s) => s.parentId === null), ...spans.filter((s) => s.parentId !== null)];
  for (const key of ["session.id", "nostr.thread_root_id", "nostr.thread_id"]) {
    const found = ordered.find((s) => typeof s.attributes[key] === "string" && s.attributes[key]);
    if (found) {
      return found.attributes[key] as string;
    }
  }
  return null;
}

export class PhoenixClient {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly #auth: PhoenixAuth;
  #projects: PhoenixProject[] | null = null;

  constructor(endpoint = "http://localhost:6006", timeoutMs = 30000, credentials: PhoenixCredentials | string | null = null) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.#auth = new PhoenixAuth(this.endpoint, timeoutMs, credentials);
  }

  private url(path: string, params?: Params): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null) {
        continue;
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        search.append(key, String(item));
      }
    }
    const query = search.toString();
    return `${this.endpoint}${path}${query ? `?${query}` : ""}`;
  }

  private async get<T>(path: string, params?: Params): Promise<T> {
    const url = this.url(path, params);
    for (let attempt = 0; ; attempt++) {
      const authorization = await this.#auth.authorization();
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": "buzz-trace",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new PhoenixAPIError(this.#auth.redact(`Connection failed to Phoenix endpoint ${this.endpoint}: ${msg}`));
      }
      // Refused once: refresh the session, sign in again, or fall back to the email and password, and try again.
      if (response.status === 401 && attempt === 0 && (await this.#auth.recover(authorization))) {
        continue;
      }
      if (!response.ok) {
        throw await this.failure(response, url);
      }
      return (await response.json()) as T;
    }
  }

  private async failure(response: Response, url: string): Promise<PhoenixAPIError> {
    let body = "";
    try {
      body = (await response.text()).slice(0, 300);
    } catch {
      // the body is only a hint
    }
    const hint = body ? ` (server said: ${this.#auth.redact(body).slice(0, 120)})` : "";
    if (response.status === 401 || response.status === 403) {
      const how =
        this.#auth.mode === "api-key" ? " and rejected the API key" : this.#auth.mode === "login" ? " and rejected the signed-in session" : "";
      return new PhoenixAPIError(
        `HTTP ${response.status} from ${this.endpoint}: Phoenix authentication is on${how}. Set PHOENIX_API_KEY (or pass --api-key) to a ` +
          "Phoenix API key, or PHOENIX_EMAIL and PHOENIX_PASSWORD to sign in." +
          hint,
        response.status,
      );
    }
    return new PhoenixAPIError(
      this.#auth.redact(`HTTP ${response.status} ${response.statusText} for ${url}${body ? ` - ${body}` : ""}`),
      response.status,
    );
  }

  /** Every item of a paginated listing, following the cursor to its end. */
  private async pages<T>(path: string, params: Params): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: { data?: T[]; next_cursor?: string | null } = await this.get(path, { ...params, cursor });
      out.push(...(res.data ?? []));
      cursor = res.next_cursor ?? null;
      if (!cursor) {
        return out;
      }
    }
    throw new PhoenixAPIError(`${path} still had more pages after ${MAX_PAGES} requests; narrow the search.`);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/healthz`, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async listProjects(): Promise<PhoenixProject[]> {
    return this.pages<PhoenixProject>("/v1/projects", { limit: PAGE });
  }

  /** The projects, asked for once per client. */
  private async knownProjects(): Promise<PhoenixProject[]> {
    this.#projects ??= await this.listProjects();
    return this.#projects;
  }

  /** The name of a project given by name or by global id. A name needs no request. */
  private async projectName(identifier: string): Promise<string> {
    if (!GLOBAL_PROJECT_ID.test(identifier) && !this.#projects) {
      return identifier;
    }
    const known = await this.knownProjects();
    return known.find((p) => p.id === identifier || p.name === identifier)?.name ?? identifier;
  }

  /**
   * The newest `limit` sessions. Without a project, those of every project, merged newest first, each with its project's name.
   */
  async listSessions(project: string | null = null, limit = 20): Promise<PhoenixSession[]> {
    const names = project ? [await this.projectName(project)] : (await this.knownProjects()).map((p) => p.name);
    const all: PhoenixSession[] = [];
    for (const name of names) {
      let res: { data?: PhoenixSession[] };
      try {
        res = await this.get<{ data?: PhoenixSession[] }>(`/v1/projects/${encodeURIComponent(name)}/sessions`, { limit, order: "desc" });
      } catch (err) {
        if (project && err instanceof PhoenixAPIError && err.statusCode === 404) {
          const known = (await this.knownProjects()).map((p) => p.name);
          throw new PhoenixAPIError(`There is no project ${name} (projects: ${known.join(", ") || "none"}).`, 404);
        }
        throw err;
      }
      for (const session of res.data ?? []) {
        all.push({ ...session, project_name: name });
      }
    }
    return all.sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)).slice(0, limit);
  }

  async getSession(sessionIdentifier: string): Promise<PhoenixSession | null> {
    try {
      const res = await this.get<{ data: PhoenixSession }>(`/v1/sessions/${encodeURIComponent(sessionIdentifier)}`);
      return res.data || null;
    } catch (err) {
      if (err instanceof PhoenixAPIError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async getSpansByAttribute(project: string, key: string, value: string): Promise<SpanNode[]> {
    // The value is JSON-parsed by Phoenix: quoting keeps an id of only digits a string.
    const spans = await this.pages<SpanNodeData>(`/v1/projects/${encodeURIComponent(project)}/spans`, {
      attribute: `${key}:${JSON.stringify(value)}`,
      ...SPAN_ORDER,
    });
    return spans.map((s) => new SpanNode(s));
  }

  /** Every span of the given traces, a few traces per request. */
  async getSpansByTraceIds(project: string, traceIds: string[]): Promise<SpanNode[]> {
    const spans: SpanNode[] = [];
    for (let i = 0; i < traceIds.length; i += TRACE_CHUNK) {
      const chunk = traceIds.slice(i, i + TRACE_CHUNK);
      const data = await this.pages<SpanNodeData>(`/v1/projects/${encodeURIComponent(project)}/spans`, { trace_id: chunk, ...SPAN_ORDER });
      spans.push(...data.map((s) => new SpanNode(s)));
    }
    return spans;
  }

  async getSpansByTraceId(project: string, traceId: string): Promise<SpanNode[]> {
    return this.getSpansByTraceIds(project, [traceId]);
  }

  /** Every span of the traces `spans` belong to: the spans found by a filter, completed with their siblings. */
  private async completeTraces(project: string, spans: SpanNode[]): Promise<SpanNode[]> {
    const traceIds = [...new Set(spans.map((s) => s.traceId).filter(Boolean))];
    const whole = await this.getSpansByTraceIds(project, traceIds);
    return whole.length > 0 ? whole : spans;
  }

  /** The spans of a thread in one project: by session id, else by the trace id or the message id it was given. */
  private async spansOfThread(project: string, id: string, depth = 0): Promise<SpanNode[]> {
    let found = await this.getSpansByAttribute(project, "session.id", id);
    if (found.length === 0) {
      const widen = async (spans: SpanNode[]): Promise<SpanNode[] | null> => {
        const sessionId = sessionIdOf(spans);
        if (sessionId && sessionId !== id && depth < 2) {
          const whole = await this.spansOfThread(project, sessionId, depth + 1);
          return whole.length > 0 ? whole : null;
        }
        return null;
      };
      if (/^[0-9a-f]{32}$/i.test(id)) {
        const byTrace = await this.getSpansByTraceIds(project, [id]);
        if (byTrace.length > 0) {
          return (await widen(byTrace)) ?? byTrace;
        }
      }
      for (const key of MESSAGE_ID_ATTRS) {
        found = await this.getSpansByAttribute(project, key, id);
        if (found.length > 0) {
          const whole = await widen(found);
          if (whole) {
            return whole;
          }
          break;
        }
      }
      if (found.length === 0) {
        return [];
      }
    }
    return this.completeTraces(project, found);
  }

  /**
   * Finds a thread given its root id (the session id), a trace id, or the id of a message in it (one that started a turn,
   * was replied to, or was posted by a recorded reply call). With a project, looks there only; without one, asks Phoenix which
   * project holds the session and, failing that, searches them all.
   */
  async locateThread(threadId: string, projectHint: string | null = null): Promise<LocatedThread> {
    const id = threadId.trim();
    let names: string[];
    if (projectHint) {
      names = [await this.projectName(projectHint)];
    } else {
      const session = await this.getSession(id);
      names = session ? [await this.projectName(session.project_id)] : (await this.knownProjects()).map((p) => p.name);
    }

    const searched: string[] = [];
    for (const name of names) {
      searched.push(name);
      let spans: SpanNode[];
      try {
        spans = await this.spansOfThread(name, id);
      } catch (err) {
        // A project that was named and does not exist: say which do.
        if (projectHint && err instanceof PhoenixAPIError && err.statusCode === 404) {
          const known = (await this.knownProjects()).map((p) => p.name);
          return { project: name, spans: [], searched, note: `there is no project ${name} (projects: ${known.join(", ") || "none"})` };
        }
        throw err;
      }
      if (spans.length > 0) {
        return { project: name, spans, searched };
      }
    }

    let note: string | undefined;
    if (projectHint) {
      const session = await this.getSession(id);
      if (session) {
        note = `the session exists in project ${await this.projectName(session.project_id)}`;
      }
    }
    return { project: projectHint ? names[0] : null, spans: [], searched, ...(note ? { note } : {}) };
  }

  /** The spans of a thread (see locateThread). `project` null means: find it. */
  async getSpansForThread(project: string | null, threadId: string): Promise<SpanNode[]> {
    return (await this.locateThread(threadId, project)).spans;
  }
}
