/**
 * Reading a thread from a live Phoenix over its REST API: how many requests it takes, that nothing is cut off (cursor,
 * limit, order), that the whole trace of every turn is read (not only the spans that carry the session id), and how the
 * project is found when the user did not name it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoenixClient } from "../src/clients/phoenix-api.js";
import { FakePhoenix, restSpan } from "./helpers/fake-phoenix.js";
import { hex } from "./helpers/phoenix-thread.js";

const SESSION = hex("session");
const TRACES = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];

function threadSpans(project = "ba") {
  const spans = [];
  TRACES.forEach((trace, i) => {
    const start = `2026-11-08T04:46:${String(12 + i * 5).padStart(2, "0")}.000000+00:00`;
    spans.push(
      restSpan({ project, trace, name: "agent_turn", kind: "AGENT", start, attributes: { "session.id": SESSION, "nostr.event_id": hex(`event-${i}`), "nostr.reply_to_id": i === 2 ? hex("parent") : undefined, "agent.name": "ba-paul-twin" } }),
      restSpan({ project, trace, name: "tool:mcp__buzz-thread__reply", kind: "TOOL", parent: "root", start, attributes: { "session.id": SESSION, "nostr.posted_event_id": i === 0 ? hex("posted") : undefined } }),
    );
  });
  // The last turn also has a span that does not carry the session id, like a steer record might.
  spans.push(
    restSpan({
      project,
      trace: TRACES[2],
      name: "steer",
      start: "2026-11-08T04:46:23.500000+00:00",
      attributes: { "nostr.event_id": hex("steered") },
      events: [{ name: "steer", timestamp: "2026-11-08T04:46:23.600000+00:00", attributes: { "nostr.event_id": hex("steered-event") } }],
    }),
  );
  return spans;
}

let fake: FakePhoenix;
beforeEach(() => {
  fake = new FakePhoenix().install();
  fake.sessions.push({ session_id: SESSION, project: "ba" });
  fake.spans.push(...threadSpans());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () => new PhoenixClient("http://phoenix.test:6006", 5000);

describe("locating a thread", () => {
  it("takes two span requests for a project that is named: the session's spans, then every span of its traces", async () => {
    const found = await client().locateThread(SESSION, "ba");
    expect(found.project).toBe("ba");
    expect(found.spans).toHaveLength(7);
    expect(fake.of(/\/spans$/)).toHaveLength(2);
    const [bySession, byTrace] = fake.of(/\/spans$/);
    expect(bySession.query.get("attribute")).toBe(`session.id:"${SESSION}"`);
    expect(byTrace.query.getAll("trace_id").sort()).toEqual([...TRACES]);
  });

  it("and one more for the annotations of the reply spans that record no id (the first turn's reply records its own)", async () => {
    const found = await client().locateThread(SESSION, "ba");
    expect(fake.calls.map((c) => c.path).filter((p) => !p.endsWith("/spans"))).toEqual(["/v1/projects/ba/span_annotations"]);
    const replies = found.spans.filter((s) => s.name === "tool:mcp__buzz-thread__reply" && !s.attributes["nostr.posted_event_id"]);
    expect(replies).toHaveLength(2);
    expect(fake.of(/\/span_annotations$/)[0].query.getAll("span_ids").sort()).toEqual(replies.map((s) => s.spanId).sort());
  });

  it("reads the spans of a trace that do not carry the session id, with their events", async () => {
    const { spans } = await client().locateThread(SESSION, "ba");
    const steer = spans.find((s) => s.name === "steer")!;
    expect(steer.attributes["nostr.event_id"]).toBe(hex("steered"));
    expect(steer.events).toHaveLength(1);
    expect(steer.events[0].name).toBe("steer");
    expect(steer.events[0].attributes["nostr.event_id"]).toBe(hex("steered-event"));
    expect(steer.events[0].time?.toISOString()).toBe("2026-11-08T04:46:23.600Z");
  });

  it("asks for the biggest page, in the order the spans started, so no tool is listed out of order", async () => {
    await client().locateThread(SESSION, "ba");
    for (const call of fake.of(/\/spans$/)) {
      expect(call.query.get("limit")).toBe("1000");
      expect(call.query.get("sort")).toBe("start_time");
      expect(call.query.get("order")).toBe("asc");
    }
  });

  it("follows the cursor: a thread of more than one page of spans is read whole", async () => {
    fake.spans.length = 0;
    for (let i = 0; i < 2300; i++) {
      fake.spans.push(
        restSpan({ trace: TRACES[i % 3], name: `tool:t${i}`, start: `2026-11-08T05:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000000+00:00`, attributes: { "session.id": SESSION } }),
      );
    }
    const { spans } = await client().locateThread(SESSION, "ba");
    expect(spans).toHaveLength(2300);
    expect(fake.of(/\/spans$/).length).toBe(6);
    expect(new Set(spans.map((s) => s.name)).size).toBe(2300);
  });

  it("puts the trace ids of a long thread into as few requests as it can", async () => {
    fake.spans.length = 0;
    const many = Array.from({ length: 120 }, (_, i) => String(i).padStart(32, "0"));
    for (const trace of many) {
      fake.spans.push(restSpan({ trace, name: "agent_turn", start: "2026-11-08T04:46:12.000000+00:00", attributes: { "session.id": SESSION } }));
    }
    const { spans } = await client().locateThread(SESSION, "ba");
    expect(spans).toHaveLength(120);
    // one request for the session's spans, three for the traces (50 each)
    expect(fake.of(/\/spans$/)).toHaveLength(4);
  });

  it("finds the project itself when it was not named: the session says which project holds it", async () => {
    const found = await client().locateThread(SESSION, null);
    expect(found.project).toBe("ba");
    expect(found.spans).toHaveLength(7);
    expect(fake.of(`/v1/sessions/${SESSION}`)).toHaveLength(1);
    expect(fake.of(/\/spans$/).every((c) => c.path === "/v1/projects/ba/spans")).toBe(true);
    expect(fake.of("/v1/projects")).toHaveLength(1);
  });

  it("searches every project for an id the session endpoint does not know, and says where it looked", async () => {
    fake.sessions.length = 0;
    fake.spans.length = 0;
    const found = await client().locateThread(hex("nowhere"), null);
    expect(found.spans).toEqual([]);
    expect(found.project).toBeNull();
    expect(found.searched).toEqual(["ba", "mobile"]);
  });

  it("looks only in the named project, and says where the thread is when it is in another", async () => {
    const found = await client().locateThread(SESSION, "mobile");
    expect(found.spans).toEqual([]);
    expect(found.searched).toEqual(["mobile"]);
    expect(found.note).toBe("the session exists in project ba");
  });

  it("says which projects exist when the one named does not", async () => {
    const found = await client().locateThread(SESSION, "nope");
    expect(found.spans).toEqual([]);
    expect(found.note).toBe("there is no project nope (projects: ba, mobile)");
  });

  it("takes a project given by its global id as well as by its name", async () => {
    const found = await client().locateThread(SESSION, "UHJvamVjdDoz");
    expect(found.spans).toHaveLength(7);
    expect(found.project).toBe("ba");
  });

  it("resolves a trace id (32 hex) to the whole thread", async () => {
    const found = await client().locateThread(TRACES[1], "ba");
    expect(found.spans).toHaveLength(7);
    expect(fake.of(/\/spans$/).some((c) => c.query.getAll("trace_id").includes(TRACES[1]))).toBe(true);
  });

  it("resolves the id of a message that started a turn, one that only appears as a parent, and one a reply call recorded", async () => {
    for (const messageId of [hex("event-1"), hex("parent"), hex("posted")]) {
      const found = await client().locateThread(messageId, "ba");
      expect(found.spans, messageId).toHaveLength(7);
    }
  });

  it("keeps working through getSpansForThread", async () => {
    expect(await client().getSpansForThread("ba", SESSION)).toHaveLength(7);
  });

  it("quotes the value of an attribute filter, so an id of only digits is not read as a number", async () => {
    const digits = "1".repeat(64);
    fake.spans.push(restSpan({ trace: TRACES[0], name: "agent_turn", start: "2026-11-08T04:46:12.000000+00:00", attributes: { "session.id": digits } }));
    const found = await client().locateThread(digits, "ba");
    expect(found.spans.length).toBeGreaterThan(0);
    expect(fake.of(/\/spans$/)[0].query.get("attribute")).toBe(`session.id:"${digits}"`);
  });
});

describe("listing sessions", () => {
  beforeEach(() => {
    fake.sessions.push(
      { session_id: hex("old"), project: "ba", start_time: "2026-11-08T01:00:00+00:00" },
      { session_id: hex("new"), project: "ba", start_time: "2026-11-08T09:00:00+00:00" },
      { session_id: hex("mobile"), project: "mobile", start_time: "2026-11-08T05:00:00+00:00" },
    );
  });

  it("asks for the newest first", async () => {
    const sessions = await client().listSessions("ba", 2);
    expect(fake.of("/v1/projects/ba/sessions")[0].query.get("order")).toBe("desc");
    expect(sessions.map((s) => s.session_id)).toEqual([hex("new"), SESSION]);
  });

  it("lists only the project asked for, though another project's session is newer", async () => {
    expect((await client().listSessions("mobile", 10)).map((s) => s.session_id)).toEqual([hex("mobile")]);
    expect((await client().listSessions("ba", 10)).map((s) => s.session_id)).toEqual([hex("new"), SESSION, hex("old")]);
  });

  it("counts the limit in sessions and passes each one's traces and tokens through", async () => {
    fake.sessions.push({ session_id: hex("busy"), project: "ba", start_time: "2026-11-08T12:00:00+00:00", tokens: 167358, traces: ["a".repeat(32), "b".repeat(32), "c".repeat(32)] });
    const [only] = await client().listSessions("ba", 1);
    expect(only.session_id).toBe(hex("busy"));
    expect(only.token_count_total).toBe(167358);
    expect(only.traces.map((t) => t.trace_id)).toEqual(["a".repeat(32), "b".repeat(32), "c".repeat(32)]);
  });

  it("says which projects exist when the one named does not, and is empty for one without a session", async () => {
    await expect(client().listSessions("no-such-project", 10)).rejects.toThrow("There is no project no-such-project (projects: ba, mobile).");
    fake.projects.push({ id: "UHJvamVjdDo5", name: "empty" });
    expect(await client().listSessions("empty", 10)).toEqual([]);
  });

  it("without a project, merges the newest of every project and names each one", async () => {
    const sessions = await client().listSessions(null, 3);
    expect(sessions.map((s) => [s.session_id.slice(0, 6), s.project_name])).toEqual([
      [hex("new").slice(0, 6), "ba"],
      [hex("mobile").slice(0, 6), "mobile"],
      [SESSION.slice(0, 6), "ba"],
    ]);
  });
});
