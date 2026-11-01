/**
 * Arize Phoenix SQLite direct reader for buzz-trace.
 * Uses Node.js native node:sqlite for zero-dependency high-speed local querying.
 */

import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SpanNode } from "../models.js";

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
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Phoenix SQLite database not found at ${dbPath}`);
    }
    this.dbPath = dbPath;
  }

  getSpansForThread(threadId: string): SpanNode[] {
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try {
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
        ORDER BY s.start_time ASC;
      `;

      const stmt = db.prepare(query);
      const rows = stmt.all(threadId, threadId) as unknown as SpanRow[];

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
}
