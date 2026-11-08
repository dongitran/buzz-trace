/**
 * A small Phoenix, as a replacement for the global `fetch`: the REST routes buzz-trace uses (`/v1/projects`, `/v1/sessions/{id}`,
 * `/v1/projects/{p}/spans` with its filters and cursor, `/v1/projects/{p}/sessions`) and the sign-in routes (`/auth/login`,
 * `/auth/refresh`), with authentication that can be switched on. Every request is recorded. All credentials in tests are fake.
 */
import { vi } from "vitest";

export interface RestSpan {
  name: string;
  context: { trace_id: string; span_id: string };
  span_kind: string;
  parent_id: string | null;
  start_time: string;
  end_time: string;
  status_code: string;
  status_message?: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; timestamp: string; attributes: Record<string, unknown> }>;
}

export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeProject {
  id: string;
  name: string;
}

export interface FakeSession {
  session_id: string;
  project: string;
  start_time?: string;
  end_time?: string;
  /** Tokens Phoenix totals for the session (`token_count_total`). */
  tokens?: number;
  /** Trace ids Phoenix lists for the session in a listing. */
  traces?: string[];
}

export class FakePhoenix {
  calls: FakeCall[] = [];
  projects: FakeProject[] = [
    { id: "UHJvamVjdDoz", name: "ba" },
    { id: "UHJvamVjdDoy", name: "mobile" },
  ];
  spans: Array<RestSpan & { project: string }> = [];
  sessions: FakeSession[] = [];
  /** Authentication: when set, a request needs a valid API key or access token. */
  requireAuth = false;
  apiKeys = new Set<string>();
  users = new Map<string, string>();
  loginRateLimited = false;
  loginMissing = false;
  /** Server-side state of the sign-in sessions. */
  accessTokens = new Set<string>();
  refreshTokens = new Set<string>();
  private counter = 0;
  /** What the next error response body says (to check that errors never repeat a credential). */
  errorBody: string | null = null;
  failWith: ((call: FakeCall) => Response | null) | null = null;

  install(): this {
    vi.stubGlobal("fetch", this.handler);
    return this;
  }

  count(method: string, path: RegExp | string): number {
    return this.calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))).length;
  }

  of(path: RegExp | string): FakeCall[] {
    return this.calls.filter((c) => (typeof path === "string" ? c.path === path : path.test(c.path)));
  }

  /** The server forgets an access token (it expired). */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  private cookies(): string[] {
    const access = `access-${++this.counter}`;
    const refresh = `refresh-${this.counter}`;
    this.accessTokens.add(access);
    this.refreshTokens.add(refresh);
    return [
      `phoenix-access-token=${access}; HttpOnly; Max-Age=600; Path=/; SameSite=lax`,
      `phoenix-refresh-token=${refresh}; HttpOnly; Max-Age=604800; Path=/; SameSite=lax`,
    ];
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private authorized(call: FakeCall): boolean {
    if (!this.requireAuth) {
      return true;
    }
    const bearer = /^Bearer (.+)$/.exec(call.headers.authorization ?? "")?.[1];
    if (bearer && (this.apiKeys.has(bearer) || this.accessTokens.has(bearer))) {
      return true;
    }
    const cookie = /phoenix-access-token=([^;\s]+)/.exec(call.headers.cookie ?? "")?.[1];
    return Boolean(cookie && this.accessTokens.has(cookie));
  }

  handler = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const call: FakeCall = {
      method: (init.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);

    const forced = this.failWith?.(call);
    if (forced) {
      return forced;
    }

    if (call.path === "/auth/login" && call.method === "POST") {
      if (this.loginMissing) {
        return new Response("Not Found", { status: 404 });
      }
      if (this.loginRateLimited) {
        return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "30" } });
      }
      const { email, password } = call.body as { email: string; password: string };
      if (this.users.get(email) !== password) {
        return new Response(this.errorBody ?? "Invalid email and/or password", { status: 401 });
      }
      const res = new Response(null, { status: 204 });
      for (const c of this.cookies()) {
        res.headers.append("set-cookie", c);
      }
      return res;
    }
    if (call.path === "/auth/refresh" && call.method === "POST") {
      const refresh = /phoenix-refresh-token=([^;\s]+)/.exec(call.headers.cookie ?? "")?.[1];
      if (!refresh || !this.refreshTokens.has(refresh)) {
        return new Response("Invalid token", { status: 401 });
      }
      this.refreshTokens.delete(refresh);
      const res = new Response(null, { status: 204 });
      for (const c of this.cookies()) {
        res.headers.append("set-cookie", c);
      }
      return res;
    }

    if (!this.authorized(call)) {
      return new Response(this.errorBody ?? "Invalid token", { status: 401, headers: { "www-authenticate": 'Bearer realm="Arize Phoenix"' } });
    }

    if (call.path === "/v1/projects") {
      return this.json({ data: this.projects, next_cursor: null });
    }
    let m = /^\/v1\/projects\/([^/]+)$/.exec(call.path);
    if (m) {
      const p = this.project(decodeURIComponent(m[1]));
      return p ? this.json({ data: p }) : this.json({ detail: "Project not found" }, 404);
    }
    m = /^\/v1\/sessions\/([^/]+)$/.exec(call.path);
    if (m) {
      const session = this.sessions.find((s) => s.session_id === decodeURIComponent(m![1]));
      if (!session) {
        return this.json({ detail: `Session with session_id ${m[1]} not found` }, 404);
      }
      const project = this.project(session.project)!;
      const traces = [...new Set(this.spans.filter((s) => s.project === session.project && s.attributes["session.id"] === session.session_id).map((s) => s.context.trace_id))];
      return this.json({
        data: {
          id: `S-${session.session_id.slice(0, 6)}`,
          session_id: session.session_id,
          project_id: project.id,
          start_time: session.start_time ?? "2026-11-08T04:46:12+00:00",
          end_time: session.end_time ?? "2026-11-08T04:46:31+00:00",
          traces: traces.map((t) => ({ id: `T-${t}`, trace_id: t, start_time: "", end_time: "" })),
        },
      });
    }
    m = /^\/v1\/projects\/([^/]+)\/sessions$/.exec(call.path);
    if (m) {
      const p = this.project(decodeURIComponent(m[1]));
      if (!p) {
        return this.json({ detail: "Project not found" }, 404);
      }
      const order = call.query.get("order") ?? "asc";
      const limit = Number(call.query.get("limit") ?? 100);
      const list = this.sessions
        .filter((s) => s.project === p.name)
        .map((s) => ({
          id: `S-${s.session_id.slice(0, 6)}`,
          session_id: s.session_id,
          project_id: p.id,
          start_time: s.start_time ?? "2026-11-08T04:46:12+00:00",
          end_time: s.end_time ?? "2026-11-08T04:46:31+00:00",
          traces: (s.traces ?? []).map((t) => ({ id: `T-${t}`, trace_id: t, start_time: "", end_time: "" })),
          token_count_total: s.tokens ?? 0,
        }))
        .sort((a, b) => (order === "desc" ? b.start_time.localeCompare(a.start_time) : a.start_time.localeCompare(b.start_time)));
      return this.json({ data: list.slice(0, limit), next_cursor: null });
    }
    m = /^\/v1\/projects\/([^/]+)\/spans$/.exec(call.path);
    if (m) {
      const p = this.project(decodeURIComponent(m[1]));
      if (!p) {
        return this.json({ detail: "Project not found" }, 404);
      }
      return this.spansResponse(p.name, call);
    }
    return this.json({ detail: "Not Found" }, 404);
  };

  project(identifier: string): FakeProject | undefined {
    return this.projects.find((p) => p.name === identifier || p.id === identifier);
  }

  private spansResponse(project: string, call: FakeCall): Response {
    const q = call.query;
    let list = this.spans.filter((s) => s.project === project);
    const traceIds = q.getAll("trace_id");
    if (traceIds.length > 0) {
      list = list.filter((s) => traceIds.includes(s.context.trace_id));
    }
    for (const filter of q.getAll("attribute")) {
      const i = filter.indexOf(":");
      const key = filter.slice(0, i);
      let value: unknown = filter.slice(i + 1);
      try {
        value = JSON.parse(value as string);
      } catch {
        // a bare word is a string
      }
      list = list.filter((s) => s.attributes[key] === value);
    }
    const order = q.get("order") ?? "desc";
    const sort = q.get("sort") ?? "id";
    const index = new Map(this.spans.map((s, i) => [s, i]));
    list = [...list].sort((a, b) => {
      const d = sort === "start_time" ? a.start_time.localeCompare(b.start_time) || index.get(a)! - index.get(b)! : index.get(a)! - index.get(b)!;
      return order === "desc" ? -d : d;
    });
    const limit = Math.min(Number(q.get("limit") ?? 100), 1000);
    const offset = Number(q.get("cursor") ?? 0);
    const page = list.slice(offset, offset + limit);
    const next = offset + limit < list.length ? String(offset + limit) : null;
    return this.json({ data: page.map(({ project: _p, ...span }) => span), next_cursor: next });
  }
}

let spanCounter = 0;

/** A REST span as Phoenix returns it. Attributes are flat dotted keys, times are ISO strings with an offset. */
export function restSpan(o: {
  project?: string;
  trace: string;
  name: string;
  kind?: string;
  parent?: string | null;
  start: string;
  end?: string;
  attributes?: Record<string, unknown>;
  events?: RestSpan["events"];
  status?: string;
}): RestSpan & { project: string } {
  return {
    project: o.project ?? "ba",
    name: o.name,
    context: { trace_id: o.trace, span_id: `span-${++spanCounter}` },
    span_kind: o.kind ?? "INTERNAL",
    parent_id: o.parent ?? null,
    start_time: o.start,
    end_time: o.end ?? o.start,
    status_code: o.status ?? "OK",
    attributes: o.attributes ?? {},
    events: o.events ?? [],
  };
}

/** A SpanNode (as the fixtures build them) in the shape Phoenix's REST API returns it. */
export function restFromNode(span: import("../../src/models.js").SpanNode, project = "ba"): RestSpan & { project: string } {
  return {
    project,
    name: span.name,
    context: { trace_id: span.traceId, span_id: span.spanId },
    span_kind: span.spanKind,
    parent_id: span.parentId ?? null,
    start_time: (span.startTime ?? new Date(0)).toISOString().replace("Z", "+00:00"),
    end_time: (span.endTime ?? span.startTime ?? new Date(0)).toISOString().replace("Z", "+00:00"),
    status_code: span.statusCode,
    attributes: Object.fromEntries(Object.entries(span.attributes).filter(([, v]) => v !== undefined)),
    events: span.events.map((e) => ({ name: e.name, timestamp: (e.time ?? new Date(0)).toISOString().replace("Z", "+00:00"), attributes: e.attributes })),
  };
}
