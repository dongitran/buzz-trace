import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PhoenixDBClient } from "../src/clients/phoenix-db.js";

describe("PhoenixDBClient", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-db-test-"));
    dbPath = path.join(tempDir, "test-phoenix.db");

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name VARCHAR UNIQUE
      );

      CREATE TABLE project_sessions (
        id INTEGER NOT NULL PRIMARY KEY,
        session_id VARCHAR NOT NULL UNIQUE,
        project_id INTEGER NOT NULL,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL
      );
      CREATE INDEX ix_project_sessions_project_id_start_time ON project_sessions (project_id, start_time DESC);

      CREATE TABLE traces (
        id INTEGER NOT NULL PRIMARY KEY,
        project_rowid INTEGER NOT NULL,
        trace_id VARCHAR NOT NULL UNIQUE,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        project_session_rowid INTEGER
      );
      CREATE INDEX ix_traces_project_session_rowid ON traces (project_session_rowid);

      CREATE TABLE spans (
        id INTEGER NOT NULL PRIMARY KEY,
        trace_rowid INTEGER NOT NULL,
        span_id VARCHAR NOT NULL UNIQUE,
        parent_id VARCHAR,
        name VARCHAR NOT NULL,
        span_kind VARCHAR NOT NULL,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        attributes TEXT,
        status_code VARCHAR DEFAULT 'OK',
        status_message VARCHAR
      );
      CREATE INDEX ix_spans_trace_rowid ON spans (trace_rowid);
      CREATE INDEX ix_spans_session_id ON spans (
        CAST(JSON_EXTRACT(attributes, '$."session"."id"') AS VARCHAR)
      ) WHERE CAST(JSON_EXTRACT(attributes, '$."session"."id"') AS VARCHAR) IS NOT NULL;
    `);

    // Insert test seed data
    db.exec(`
      INSERT INTO projects (id, name) VALUES (1, 'mobile');

      INSERT INTO project_sessions (id, session_id, project_id, start_time, end_time)
      VALUES (10, 'thread-session-123', 1, '2026-11-01T08:00:00Z', '2026-11-01T08:05:00Z');

      INSERT INTO traces (id, project_rowid, trace_id, start_time, end_time, project_session_rowid)
      VALUES 
        (100, 1, 'trace-alpha-001', '2026-11-01T08:00:00Z', '2026-11-01T08:01:00Z', 10),
        (101, 1, 'trace-alpha-002', '2026-11-01T08:02:00Z', '2026-11-01T08:03:00Z', 10),
        (200, 1, 'trace-standalone-001', '2026-11-01T09:00:00Z', '2026-11-01T09:01:00Z', NULL);

      INSERT INTO spans (id, trace_rowid, span_id, parent_id, name, span_kind, start_time, end_time, attributes)
      VALUES
        (1, 100, 'span-1', NULL, 'agent_turn', 'AGENT', '2026-11-01T08:00:00Z', '2026-11-01T08:01:00Z', '{"session":{"id":"thread-session-123"},"agent":{"name":"builder"}}'),
        (2, 100, 'span-2', 'span-1', 'tool:read_file', 'TOOL', '2026-11-01T08:00:10Z', '2026-11-01T08:00:15Z', '{"tool":{"name":"read_file"}}'),
        (3, 101, 'span-3', NULL, 'agent_turn', 'AGENT', '2026-11-01T08:02:00Z', '2026-11-01T08:03:00Z', '{"session":{"id":"thread-session-123"},"agent":{"name":"reviewer"}}'),
        (4, 200, 'span-4', NULL, 'agent_turn', 'AGENT', '2026-11-01T09:00:00Z', '2026-11-01T09:01:00Z', '{"session":{"id":"standalone-session-456"}}');
    `);

    db.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("throws an error when database file does not exist", () => {
    expect(() => new PhoenixDBClient("/non/existent/path/phoenix.db")).toThrow("Phoenix SQLite database not found");
  });

  it("resolves all spans for a thread by session_id via UNION index lookup", () => {
    const client = new PhoenixDBClient(dbPath);
    const spans = client.getSpansForThread("thread-session-123");

    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.spanId)).toEqual(["span-1", "span-2", "span-3"]);
    expect(spans[0].name).toBe("agent_turn");
    expect(spans[1].name).toBe("tool:read_file");
    expect(spans[2].name).toBe("agent_turn");
  });

  it("resolves spans when querying directly by trace_id", () => {
    const client = new PhoenixDBClient(dbPath);
    const spans = client.getSpansForThread("trace-standalone-001");

    expect(spans).toHaveLength(1);
    expect(spans[0].spanId).toBe("span-4");
    expect(spans[0].traceId).toBe("trace-standalone-001");
  });

  it("resolves spans matching ix_spans_session_id when project_session row is missing", () => {
    const client = new PhoenixDBClient(dbPath);
    const spans = client.getSpansForThread("standalone-session-456");

    expect(spans).toHaveLength(1);
    expect(spans[0].spanId).toBe("span-4");
    expect(spans[0].traceId).toBe("trace-standalone-001");
  });

  it("returns empty array for non-existent thread ID", () => {
    const client = new PhoenixDBClient(dbPath);
    const spans = client.getSpansForThread("non-existent-id-999");
    expect(spans).toEqual([]);
  });

  it("lists recent sessions correctly", () => {
    const client = new PhoenixDBClient(dbPath);
    const sessions = client.listSessions("mobile", 10);

    expect(sessions.length).toBeGreaterThan(0);
    const session123 = sessions.find((s) => s.session_id === "thread-session-123");
    expect(session123).toBeDefined();
    expect(session123?.traces.length).toBe(2);
  });
});
