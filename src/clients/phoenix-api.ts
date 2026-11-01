/**
 * Arize Phoenix REST API client for buzz-trace.
 * Built using Node.js native fetch for zero external dependencies.
 */

import { SpanNode, SpanNodeData } from "../models.js";

export class PhoenixAPIError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "PhoenixAPIError";
    this.statusCode = statusCode;
  }
}

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
  start_time: string;
  end_time: string;
  traces: PhoenixSessionTrace[];
  token_count_prompt: number;
  token_count_completion: number;
  token_count_total: number;
}

export class PhoenixClient {
  readonly endpoint: string;
  readonly timeoutMs: number;

  constructor(endpoint = "http://localhost:6006", timeoutMs = 10000) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  private async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    let url = `${this.endpoint}${path}`;
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null) {
          searchParams.append(key, String(val));
        }
      }
      const queryStr = searchParams.toString();
      if (queryStr) {
        url = `${url}?${queryStr}`;
      }
    }

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "buzz-trace/0.1.0",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        let errBody = "";
        try {
          errBody = await response.text();
        } catch {
          // Ignore read error
        }
        throw new PhoenixAPIError(
          `HTTP ${response.status} ${response.statusText} for ${url}${errBody ? ` - ${errBody}` : ""}`,
          response.status,
        );
      }

      return (await response.json()) as T;
    } catch (err: unknown) {
      if (err instanceof PhoenixAPIError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new PhoenixAPIError(`Connection failed to Phoenix endpoint ${this.endpoint}: ${msg}`);
    }
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

  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    const res = await this.get<{ data: Array<{ id: string; name: string }> }>("/v1/projects");
    return res.data || [];
  }

  async listSessions(project = "mobile", limit = 20): Promise<PhoenixSession[]> {
    const res = await this.get<{ data: PhoenixSession[] }>(`/v1/projects/${encodeURIComponent(project)}/sessions`, {
      limit,
    });
    return res.data || [];
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
    const res = await this.get<{ data: SpanNodeData[] }>(`/v1/projects/${encodeURIComponent(project)}/spans`, {
      attribute: `${key}:${value}`,
    });
    return (res.data || []).map((s) => new SpanNode(s));
  }

  async getSpansByTraceId(project: string, traceId: string): Promise<SpanNode[]> {
    const res = await this.get<{ data: SpanNodeData[] }>(`/v1/projects/${encodeURIComponent(project)}/spans`, {
      trace_id: traceId,
    });
    return (res.data || []).map((s) => new SpanNode(s));
  }

  async getSpansForThread(project: string, threadId: string): Promise<SpanNode[]> {
    const cleanId = threadId.trim();

    // 1. Direct Trace ID lookup (32 hex characters):
    if (/^[0-9a-fA-F]{32}$/.test(cleanId)) {
      const traceSpans = await this.getSpansByTraceId(project, cleanId);
      if (traceSpans.length > 0) {
        // Resolve full session if available
        const root = traceSpans.find((s) => s.parentId === null) || traceSpans[0];
        const sessionId = (root.attributes["session.id"] || root.attributes["nostr.thread_id"]) as string | undefined;
        if (sessionId && sessionId !== cleanId) {
          const sessionSpans = await this.getSpansForThread(project, sessionId);
          if (sessionSpans.length > 0) {
            return sessionSpans;
          }
        }
        return traceSpans;
      }
    }

    // 2. Primary lookup: spans where session.id = threadId
    let rootSpans = await this.getSpansByAttribute(project, "session.id", cleanId);

    // 3. Fallback: match by nostr.thread_id
    if (rootSpans.length === 0) {
      rootSpans = await this.getSpansByAttribute(project, "nostr.thread_id", cleanId);
    }

    // 4. Fallback: match by nostr.event_id (when given a specific message event ID)
    if (rootSpans.length === 0) {
      const eventSpans = await this.getSpansByAttribute(project, "nostr.event_id", cleanId);
      if (eventSpans.length > 0) {
        const root = eventSpans[0];
        const sessionId = (root.attributes["session.id"] || root.attributes["nostr.thread_id"]) as string | undefined;
        if (sessionId && sessionId !== cleanId) {
          const sessionSpans = await this.getSpansForThread(project, sessionId);
          if (sessionSpans.length > 0) {
            return sessionSpans;
          }
        }
        return eventSpans;
      }
    }

    if (rootSpans.length > 0) {
      const uniqueTraceIds = Array.from(new Set(rootSpans.map((s) => s.traceId).filter(Boolean)));
      const traceSpansArray = await Promise.all(
        uniqueTraceIds.map((tid) => this.getSpansByTraceId(project, tid)),
      );
      return traceSpansArray.flat();
    }

    // 5. Secondary lookup: match in sessions list
    try {
      const sessions = await this.listSessions(project, 50);
      const matched = sessions.find((s) => s.session_id === cleanId || s.id === cleanId);
      if (matched && matched.traces) {
        const traceIds = matched.traces.map((tr) => tr.trace_id).filter(Boolean) as string[];
        const traceSpansArray = await Promise.all(
          traceIds.map((tid) => this.getSpansByTraceId(project, tid)),
        );
        return traceSpansArray.flat();
      }
    } catch {
      // Fallback
    }

    return [];
  }
}
