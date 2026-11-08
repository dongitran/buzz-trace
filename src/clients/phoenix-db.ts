/**
 * Arize Phoenix SQLite direct reader for buzz-trace.
 * Uses Node.js native node:sqlite for zero-dependency high-speed local querying.
 */

import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SpanNode } from "../models.js";
import type { PhoenixSession } from "./phoenix-api.js";

interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_id: string | null;
  name: string;
  span_kind: string;
  start_time: string | null;
  end_time: string | null;
  status_code: string | null;
  status_message: string | null;
  attributes: string | null;
}

function flattenAttributes(
  obj: Record<string, unknown>,
  prefix = "",
  res: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      flattenAttributes(value as Record<string, unknown>, newKey, res);
    } else {
      res[newKey] = value;
    }
    if (!prefix) {
      res[key] = value;
    }
  }
  return res;
}

export class PhoenixDBClient {
  readonly dbPath: string;
  private dbInstance: DatabaseSync | null = null;

  constructor(dbPath: string) {
    const filePath = dbPath.replace(/^file:/, "").split("?")[0];
    if (!fs.existsSync(filePath)) {
      throw new Error(`Phoenix SQLite database not found at ${dbPath}`);
    }
    this.dbPath = filePath;
  }

  private getDb(): DatabaseSync {
    if (!this.dbInstance) {
      this.dbInstance = new DatabaseSync(this.dbPath, { readOnly: true });
      this.dbInstance.exec("PRAGMA busy_timeout = 5000;");
      this.dbInstance.exec("PRAGMA query_only = ON;");
    }
    return this.dbInstance;
  }

  close(): void {
    if (this.dbInstance) {
      try {
        this.dbInstance.close();
      } catch {}
      this.dbInstance = null;
    }
  }

  getSpansForThread(threadId: string): SpanNode[] {
    const cleanId = threadId.trim();
    const db = this.getDb();

    // 1. Identify all trace IDs associated with this thread / session / event via UNION covering index optimization
      const traceQuery = `
        SELECT t.id
        FROM traces t
        JOIN project_sessions ps ON t.project_session_rowid = ps.id
        WHERE ps.session_id = ?
        UNION
        SELECT t.id
        FROM traces t
        WHERE t.trace_id = ?
        UNION
        SELECT s.trace_rowid AS id
        FROM spans s
        WHERE CAST(json_extract(s.attributes, '$."session"."id"') AS VARCHAR) = ?;
      `;

      const stmt = db.prepare(traceQuery);
      const traceRows = stmt.all(cleanId, cleanId, cleanId) as unknown as Array<{ id: number }>;

      if (traceRows.length === 0) {
        return [];
      }

      // 2. Fetch all spans (root and child tool/LLM spans) for these traces
      const placeholders = traceRows.map(() => "?").join(",");
      const spansQuery = `
        SELECT 
            t.trace_id,
            s.span_id,
            s.parent_id,
            s.name,
            s.span_kind,
            s.start_time,
            s.end_time,
            s.status_code,
            s.status_message,
            s.attributes
        FROM spans s
        JOIN traces t ON s.trace_rowid = t.id
        WHERE s.trace_rowid IN (${placeholders})
        ORDER BY s.start_time ASC;
      `;

      const spanStmt = db.prepare(spansQuery);
      const rows = spanStmt.all(...traceRows.map((r) => r.id)) as unknown as SpanRow[];

      return rows.map((row) => {
        let parsedAttrs: Record<string, unknown> = {};
        if (row.attributes) {
          try {
            parsedAttrs = flattenAttributes(JSON.parse(row.attributes));
          } catch {
            // Ignore JSON parse error
          }
        }

        const openInferenceKind = parsedAttrs["openinference.span.kind"] as string | undefined;
        const resolvedKind =
          row.span_kind === "SPAN_KIND_INTERNAL" && openInferenceKind
            ? openInferenceKind
            : row.span_kind || openInferenceKind || "SPAN_KIND_INTERNAL";

        return new SpanNode({
          span_id: row.span_id,
          trace_id: row.trace_id,
          parent_id: row.parent_id,
          name: row.name,
          span_kind: resolvedKind,
          start_time: row.start_time || undefined,
          end_time: row.end_time || undefined,
          status_code: row.status_code || "OK",
          status_message: row.status_message,
          attributes: parsedAttrs,
        });
      });
  }

  /** When the database was last written (its WAL counts: Phoenix writes there first). */
  modifiedAt(): Date {
    let latest = fs.statSync(this.dbPath).mtimeMs;
    try {
      latest = Math.max(latest, fs.statSync(`${this.dbPath}-wal`).mtimeMs);
    } catch {
      // no WAL file: the database file's time stands
    }
    return new Date(latest);
  }

  /**
   * The newest `limit` sessions of `project`. Phoenix groups a thread's traces into a session; a trace that belongs
   * to none is listed as a session of its own, named by the session id its turn carries (else by its trace id). A
   * session's tokens are those of its model calls (LLM spans), so a turn's copy on the agent span is not counted twice.
   */
  listSessions(project = "mobile", limit = 10): PhoenixSession[] {
    const db = this.getDb();
    const projectRow = db.prepare("SELECT id FROM projects WHERE name = ?").get(project) as { id: number } | undefined;
    if (!projectRow) {
      return [];
    }

    interface TraceRow {
      rowid: number;
      trace_id: string;
      start_time: string;
      end_time: string;
      session_rowid: number | null;
      session_attr: string | null;
      tokens: number;
    }
    const tokensOf = (alias: string) => `COALESCE(
        CAST(json_extract(${alias}.attributes, '$.llm.token_count.total') AS INTEGER),
        CAST(json_extract(${alias}.attributes, '$.llm.token_count.prompt') AS INTEGER) +
          CAST(json_extract(${alias}.attributes, '$.llm.token_count.completion') AS INTEGER),
        0)`;
    const traceSelect = `
      SELECT t.id AS rowid, t.trace_id, t.start_time, t.end_time, t.project_session_rowid AS session_rowid,
        (SELECT json_extract(r.attributes, '$.session.id') FROM spans r
          WHERE r.trace_rowid = t.id AND r.parent_id IS NULL LIMIT 1) AS session_attr,
        COALESCE(
          (SELECT SUM(${tokensOf("l")}) FROM spans l WHERE l.trace_rowid = t.id AND l.span_kind = 'LLM'),
          (SELECT ${tokensOf("r2")} FROM spans r2 WHERE r2.trace_rowid = t.id AND r2.parent_id IS NULL LIMIT 1),
          0) AS tokens
      FROM traces t`;

    const sessionRows = db
      .prepare(
        `SELECT id AS rowid, session_id, start_time, end_time FROM project_sessions
         WHERE project_id = ? ORDER BY start_time DESC LIMIT ?`,
      )
      .all(projectRow.id, limit) as unknown as Array<{ rowid: number; session_id: string; start_time: string; end_time: string }>;

    const sessions: PhoenixSession[] = [];
    if (sessionRows.length > 0) {
      const marks = sessionRows.map(() => "?").join(",");
      const traceRows = db
        .prepare(`${traceSelect} WHERE t.project_session_rowid IN (${marks}) ORDER BY t.start_time ASC`)
        .all(...sessionRows.map((r) => r.rowid)) as unknown as TraceRow[];
      for (const row of sessionRows) {
        const own = traceRows.filter((t) => t.session_rowid === row.rowid);
        sessions.push({
          id: row.session_id,
          session_id: row.session_id,
          project_id: project,
          start_time: row.start_time,
          end_time: row.end_time,
          traces: own.map((t) => ({ id: t.trace_id, trace_id: t.trace_id, start_time: t.start_time, end_time: t.end_time })),
          token_count_prompt: 0,
          token_count_completion: 0,
          token_count_total: own.reduce((acc, t) => acc + t.tokens, 0),
        });
      }
    }

    const orphanRows = db
      .prepare(`${traceSelect} WHERE t.project_rowid = ? AND t.project_session_rowid IS NULL ORDER BY t.start_time DESC LIMIT ?`)
      .all(projectRow.id, limit) as unknown as TraceRow[];
    const orphans = new Map<string, PhoenixSession>();
    for (const t of orphanRows) {
      const sid = t.session_attr || t.trace_id;
      const existing = orphans.get(sid);
      const trace = { id: t.trace_id, trace_id: t.trace_id, start_time: t.start_time, end_time: t.end_time };
      if (existing) {
        existing.traces.push(trace);
        existing.token_count_total += t.tokens;
        if (t.start_time < existing.start_time) {
          existing.start_time = t.start_time;
        }
        if (t.end_time > existing.end_time) {
          existing.end_time = t.end_time;
        }
      } else {
        orphans.set(sid, {
          id: sid,
          session_id: sid,
          project_id: project,
          start_time: t.start_time,
          end_time: t.end_time,
          traces: [trace],
          token_count_prompt: 0,
          token_count_completion: 0,
          token_count_total: t.tokens,
        });
      }
    }
    for (const orphan of orphans.values()) {
      orphan.traces.sort((a, b) => a.start_time.localeCompare(b.start_time));
    }

    return [...sessions, ...orphans.values()]
      .sort((a, b) => b.start_time.localeCompare(a.start_time))
      .slice(0, limit);
  }
}
