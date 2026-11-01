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

export class PhoenixDBClient {
  readonly dbPath: string;

  constructor(dbPath: string) {
    const filePath = dbPath.replace(/^file:/, "").split("?")[0];
    if (!fs.existsSync(filePath)) {
      throw new Error(`Phoenix SQLite database not found at ${dbPath}`);
    }
    this.dbPath = filePath;
  }

  getSpansForThread(threadId: string): SpanNode[] {
    const cleanId = threadId.trim();
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA query_only = ON;");
      const query = `
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
        WHERE json_extract(s.attributes, '$.session.id') = ?
           OR json_extract(s.attributes, '$.attributes.session.id') = ?
           OR json_extract(s.attributes, '$.nostr.thread_id') = ?
           OR json_extract(s.attributes, '$.attributes.nostr.thread_id') = ?
           OR json_extract(s.attributes, '$.nostr.event_id') = ?
           OR json_extract(s.attributes, '$.attributes.nostr.event_id') = ?
           OR t.trace_id = ?
        ORDER BY s.start_time ASC;
      `;

      const stmt = db.prepare(query);
      let rows = stmt.all(cleanId, cleanId, cleanId, cleanId, cleanId, cleanId, cleanId) as unknown as SpanRow[];

      // If matched a trace or event, check if they belong to a larger session
      if (rows.length > 0) {
        for (const r of rows) {
          if (r.attributes) {
            try {
              const parsed = JSON.parse(r.attributes);
              const sid = (parsed["session.id"] || parsed?.attributes?.["session.id"] || parsed["nostr.thread_id"]) as string | undefined;
              if (sid && sid !== cleanId) {
                const sessionStmt = db.prepare(`
                  SELECT t.trace_id, s.span_id, s.parent_id, s.name, s.span_kind, s.start_time, s.end_time, s.status_code, s.status_message, s.attributes
                  FROM spans s
                  JOIN traces t ON s.trace_rowid = t.id
                  WHERE json_extract(s.attributes, '$.session.id') = ?
                     OR json_extract(s.attributes, '$.attributes.session.id') = ?
                     OR json_extract(s.attributes, '$.nostr.thread_id') = ?
                  ORDER BY s.start_time ASC;
                `);
                const sessionRows = sessionStmt.all(sid, sid, sid) as unknown as SpanRow[];
                if (sessionRows.length > 0) {
                  rows = sessionRows;
                  break;
                }
              }
            } catch {
              // Ignore parse error
            }
          }
        }
      }

      return rows.map((row) => {
        let parsedAttrs: Record<string, unknown> = {};
        if (row.attributes) {
          try {
            parsedAttrs = JSON.parse(row.attributes);
          } catch {
            // Ignore JSON parse error
          }
        }

        return new SpanNode({
          span_id: row.span_id,
          trace_id: row.trace_id,
          parent_id: row.parent_id,
          name: row.name,
          span_kind: row.span_kind,
          start_time: row.start_time || undefined,
          end_time: row.end_time || undefined,
          status_code: row.status_code || "OK",
          status_message: row.status_message,
          attributes: parsedAttrs,
        });
      });
    } finally {
      db.close();
    }
  }

  listSessions(_project = "mobile", limit = 10): PhoenixSession[] {
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA query_only = ON;");
      const stmt = db.prepare(`
        SELECT 
          coalesce(json_extract(attributes, '$.session.id'), json_extract(attributes, '$.attributes.session.id'), t.trace_id) as session_id,
          t.trace_id,
          t.start_time,
          t.end_time
        FROM traces t
        LEFT JOIN spans s ON s.trace_rowid = t.id AND s.parent_id IS NULL
        WHERE session_id IS NOT NULL
        GROUP BY t.trace_id
        ORDER BY t.start_time DESC
        LIMIT ?;
      `);
      const rows = stmt.all(limit) as unknown as Array<{ session_id: string; trace_id: string; start_time: string; end_time: string }>;

      const map = new Map<string, PhoenixSession>();
      for (const r of rows) {
        const existing = map.get(r.session_id) || {
          id: r.session_id,
          session_id: r.session_id,
          project_id: _project,
          start_time: r.start_time,
          end_time: r.end_time,
          traces: [],
          token_count_prompt: 0,
          token_count_completion: 0,
          token_count_total: 0,
        };
        existing.traces.push({
          id: r.trace_id,
          trace_id: r.trace_id,
          start_time: r.start_time,
          end_time: r.end_time,
        });
        map.set(r.session_id, existing);
      }
      return Array.from(map.values()).slice(0, limit);
    } finally {
      db.close();
    }
  }
}
