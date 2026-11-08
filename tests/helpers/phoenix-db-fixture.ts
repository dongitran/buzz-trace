/** A SQLite file shaped like Arize Phoenix's, with two projects and a few sessions, for tests that read it. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Fixture {
  dir: string;
  dbPath: string;
  cleanup: () => void;
}

const SCHEMA = `
  CREATE TABLE projects (id INTEGER PRIMARY KEY, name VARCHAR UNIQUE);
  CREATE TABLE project_sessions (
    id INTEGER NOT NULL PRIMARY KEY, session_id VARCHAR NOT NULL UNIQUE, project_id INTEGER NOT NULL,
    start_time TIMESTAMP NOT NULL, end_time TIMESTAMP NOT NULL
  );
  CREATE TABLE traces (
    id INTEGER NOT NULL PRIMARY KEY, project_rowid INTEGER NOT NULL, trace_id VARCHAR NOT NULL UNIQUE,
    start_time TIMESTAMP NOT NULL, end_time TIMESTAMP NOT NULL, project_session_rowid INTEGER
  );
  CREATE TABLE spans (
    id INTEGER NOT NULL PRIMARY KEY, trace_rowid INTEGER NOT NULL, span_id VARCHAR NOT NULL UNIQUE, parent_id VARCHAR,
    name VARCHAR NOT NULL, span_kind VARCHAR NOT NULL, start_time TIMESTAMP NOT NULL, end_time TIMESTAMP NOT NULL,
    attributes TEXT, status_code VARCHAR DEFAULT 'OK', status_message VARCHAR
  );
`;

/**
 * Project `ba` (id 1): session S-NEW (3 traces, an agent turn of 1,000 tokens each, started 08:00) and S-OLD (1 trace,
 * 500 tokens, 07:00). Project `mobile` (id 2): session S-MOBILE (1 trace, 09:00, the newest of all) and one trace that
 * belongs to no session (`orphan-trace`, session.id `orphan-session`).
 */
export function makePhoenixDb(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-trace-db-"));
  const dbPath = path.join(dir, "phoenix.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.exec(`INSERT INTO projects (id, name) VALUES (1, 'ba'), (2, 'mobile');`);
  const sessions: Array<[number, string, number, string, string]> = [
    [10, "S-NEW", 1, "2026-11-08 08:00:00", "2026-11-08 08:05:00"],
    [11, "S-OLD", 1, "2026-11-08 07:00:00", "2026-11-08 07:01:00"],
    [12, "S-MOBILE", 2, "2026-11-08 09:00:00", "2026-11-08 09:01:00"],
  ];
  for (const [id, sid, project, start, end] of sessions) {
    db.prepare("INSERT INTO project_sessions VALUES (?, ?, ?, ?, ?)").run(id, sid, project, start, end);
  }
  let span = 0;
  const addTrace = (rowid: number, project: number, trace: string, session: number | null, start: string, tokens: number, sessionAttr: string) => {
    db.prepare("INSERT INTO traces VALUES (?, ?, ?, ?, ?, ?)").run(rowid, project, trace, start, start, session);
    const attrs = (kind: string) => JSON.stringify({ session: { id: sessionAttr }, llm: { token_count: { total: kind === "LLM" ? tokens : tokens } } });
    db.prepare("INSERT INTO spans (id, trace_rowid, span_id, parent_id, name, span_kind, start_time, end_time, attributes) VALUES (?, ?, ?, NULL, 'agent_turn', 'AGENT', ?, ?, ?)").run(++span, rowid, `s${span}`, start, start, attrs("AGENT"));
    db.prepare("INSERT INTO spans (id, trace_rowid, span_id, parent_id, name, span_kind, start_time, end_time, attributes) VALUES (?, ?, ?, ?, 'llm:sonnet', 'LLM', ?, ?, ?)").run(++span, rowid, `s${span}`, `s${span - 1}`, start, start, attrs("LLM"));
  };
  addTrace(100, 1, "ba-t1", 10, "2026-11-08 08:00:00", 1000, "S-NEW");
  addTrace(101, 1, "ba-t2", 10, "2026-11-08 08:01:00", 1000, "S-NEW");
  addTrace(102, 1, "ba-t3", 10, "2026-11-08 08:02:00", 1000, "S-NEW");
  addTrace(103, 1, "ba-old", 11, "2026-11-08 07:00:00", 500, "S-OLD");
  addTrace(200, 2, "mobile-t1", 12, "2026-11-08 09:00:00", 700, "S-MOBILE");
  addTrace(201, 2, "orphan-trace", null, "2026-11-08 06:00:00", 300, "orphan-session");
  db.close();
  return { dir, dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
