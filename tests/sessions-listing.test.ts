/** `buzz-trace sessions`: the sessions of the project asked for, newest first, with their traces and tokens. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhoenixDBClient } from "../src/clients/phoenix-db.js";
import { type Fixture, makePhoenixDb } from "./helpers/phoenix-db-fixture.js";

describe("PhoenixDBClient.listSessions", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makePhoenixDb();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it("lists only the project asked for, though another project's session is newer", () => {
    const client = new PhoenixDBClient(fx.dbPath);
    expect(client.listSessions("ba", 10).map((s) => s.session_id)).toEqual(["S-NEW", "S-OLD"]);
    expect(client.listSessions("mobile", 10).map((s) => s.session_id)).toEqual(["S-MOBILE", "orphan-session"]);
    expect(client.listSessions("no-such-project", 10)).toEqual([]);
  });

  it("counts the limit in sessions, not in traces, and lists every trace of a session", () => {
    const client = new PhoenixDBClient(fx.dbPath);
    const [only] = client.listSessions("ba", 1);
    expect(only.session_id).toBe("S-NEW");
    expect(only.traces.map((t) => t.trace_id)).toEqual(["ba-t1", "ba-t2", "ba-t3"]);
  });

  it("totals a session's tokens from its model calls, once per call", () => {
    const client = new PhoenixDBClient(fx.dbPath);
    const byId = Object.fromEntries(client.listSessions("ba", 10).map((s) => [s.session_id, s.token_count_total]));
    expect(byId).toEqual({ "S-NEW": 3000, "S-OLD": 500 });
  });

  it("gives a trace that belongs to no session a session of its own, named by the turn's session id", () => {
    const client = new PhoenixDBClient(fx.dbPath);
    const orphan = client.listSessions("mobile", 10).find((s) => s.session_id === "orphan-session");
    expect(orphan?.traces.map((t) => t.trace_id)).toEqual(["orphan-trace"]);
    expect(orphan?.token_count_total).toBe(300);
  });

  it("reports when the file was last written, so a stale copy can be told from a live one", () => {
    const client = new PhoenixDBClient(fx.dbPath);
    expect(Math.abs(Date.now() - client.modifiedAt().getTime())).toBeLessThan(60_000);
  });
});
