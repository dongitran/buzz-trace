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
    // 1. Primary lookup: spans where session.id = threadId
    const rootSpans = await this.getSpansByAttribute(project, "session.id", threadId);
    if (rootSpans.length > 0) {
      const uniqueTraceIds = Array.from(new Set(rootSpans.map((s) => s.traceId).filter(Boolean)));
      const allSpans: SpanNode[] = [];
      for (const tid of uniqueTraceIds) {
        const traceSpans = await this.getSpansByTraceId(project, tid);
        allSpans.push(...traceSpans);
      }
      return allSpans;
    }

    // 2. Secondary lookup: match in sessions list
    try {
      const sessions = await this.listSessions(project, 50);
      const matched = sessions.find((s) => s.session_id === threadId || s.id === threadId);
      if (matched && matched.traces) {
        const allSpans: SpanNode[] = [];
        for (const tr of matched.traces) {
          if (tr.trace_id) {
            const traceSpans = await this.getSpansByTraceId(project, tr.trace_id);
            allSpans.push(...traceSpans);
          }
        }
        return allSpans;
      }
    } catch {
      // Fallback
    }

    return [];
  }
}
