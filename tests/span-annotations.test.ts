/**
 * Reading `nostr.posted_event_id` span annotations from a live Phoenix: one request per batch of reply spans that do not
 * record their id, `span_ids` repeated, the cursor followed, nothing asked when there is nothing to ask, nothing written, and
 * what a person sees of an old thread once an operator has completed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoenixClient } from "../src/clients/phoenix-api.js";
import { main } from "../src/cli.js";
import { FakePhoenix, restFromNode, restSpan } from "./helpers/fake-phoenix.js";
import { hex, THREAD_C, threadC, turnSpans } from "./helpers/phoenix-thread.js";

const NAME = "nostr.posted_event_id";
const API_KEY = "fake-api-key-ANNO0001";

let fake: FakePhoenix;
beforeEach(() => {
  fake = new FakePhoenix().install();
  fake.sessions.push({ session_id: THREAD_C.root, project: "ba" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const client = () => new PhoenixClient("http://phoenix.test:6006", 5000);
const load = (spans: ReturnType<typeof threadC>) => fake.spans.push(...spans.map((s) => restFromNode(s)));
const annotateRest = (spanId: string, label: string | null, extra: Partial<(typeof fake.annotations)[number]> = {}) =>
  fake.annotations.push({ span_id: spanId, name: NAME, label, ...extra });
const asked = () => fake.of(/\/span_annotations$/);

describe("asking Phoenix for the annotations of a thread's reply spans", () => {
  beforeEach(() => {
    load(threadC());
    annotateRest("t1-kent-post0", THREAD_C.kentMessage);
    annotateRest("t2-paul-post0", THREAD_C.paulMessage);
    annotateRest("t3-paul-post0", hex("c-paul-answer"));
  });

  it("takes one request, after the spans, for the reply spans only, with span_ids repeated", async () => {
    await client().locateThread(THREAD_C.root, "ba");
    expect(fake.calls.map((c) => c.path)).toEqual([
      "/v1/projects/ba/spans",
      "/v1/projects/ba/spans",
      "/v1/projects/ba/span_annotations",
    ]);
    const [call] = asked();
    expect(call.method).toBe("GET");
    // The thread has 14 spans; the thread_read tool, the model calls and the turns are not asked about.
    expect(call.query.getAll("span_ids").sort()).toEqual(["t1-kent-post0", "t2-paul-post0", "t3-paul-post0"]);
    expect(call.query.getAll("span_ids").some((id) => id.includes(","))).toBe(false);
    expect(call.query.getAll("include_annotation_names")).toEqual([NAME]);
    expect(call.query.get("limit")).toBe("1000");
  });

  it("puts each annotation on its span: name, label, and when it was written", async () => {
    const { spans } = await client().locateThread(THREAD_C.root, "ba");
    const post = (id: string) => spans.find((s) => s.spanId === id)!;
    expect(post("t1-kent-post0").annotations).toEqual([{ name: NAME, label: THREAD_C.kentMessage, at: Date.parse("2026-11-08T07:43:53+00:00") }]);
    expect(post("t2-paul-post0").annotations.map((a) => a.label)).toEqual([THREAD_C.paulMessage]);
    expect(spans.find((s) => s.name === "agent_turn")!.annotations).toEqual([]);
  });

  it("reads the time of an annotation as updated_at, else created_at, else none", async () => {
    fake.annotations.length = 0;
    annotateRest("t1-kent-post0", THREAD_C.kentMessage, { created_at: "2026-11-08T07:00:00+00:00", updated_at: "2026-11-08T08:00:00+00:00" });
    annotateRest("t2-paul-post0", THREAD_C.paulMessage, { created_at: "2026-11-08T07:00:00+00:00", updated_at: null });
    annotateRest("t3-paul-post0", hex("c-paul-answer"), { created_at: null, updated_at: null });
    const { spans } = await client().locateThread(THREAD_C.root, "ba");
    const at = (id: string) => spans.find((s) => s.spanId === id)!.annotations[0].at;
    expect(at("t1-kent-post0")).toBe(Date.parse("2026-11-08T08:00:00+00:00"));
    expect(at("t2-paul-post0")).toBe(Date.parse("2026-11-08T07:00:00+00:00"));
    expect(at("t3-paul-post0")).toBeNull();
  });

  it("keeps every annotation a span has, so that the latest can be told", async () => {
    annotateRest("t1-kent-post0", hex("newer"), { identifier: "second-pass", updated_at: "2026-11-08T09:00:00+00:00" });
    const { spans } = await client().locateThread(THREAD_C.root, "ba");
    expect(spans.find((s) => s.spanId === "t1-kent-post0")!.annotations.map((a) => a.label).sort()).toEqual([THREAD_C.kentMessage, hex("newer")].sort());
  });

  it("writes nothing: every request to Phoenix is a GET", async () => {
    await client().locateThread(THREAD_C.root, "ba");
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
    expect(fake.calls.some((c) => c.body !== undefined)).toBe(false);
  });

  it("sends the credentials the other requests send", async () => {
    fake.requireAuth = true;
    fake.apiKeys.add(API_KEY);
    await new PhoenixClient("http://phoenix.test:6006", 5000, API_KEY).locateThread(THREAD_C.root, "ba");
    expect(asked()).toHaveLength(1);
    expect(fake.calls.every((c) => c.headers.authorization === `Bearer ${API_KEY}`)).toBe(true);
  });
});

describe("not asking when there is nothing to ask", () => {
  it("does not ask about a reply span that records its own id", async () => {
    load(threadC({ kentId: true, paulId: true }));
    await client().locateThread(THREAD_C.root, "ba");
    expect(asked()).toHaveLength(1);
    expect(asked()[0].query.getAll("span_ids")).toEqual(["t3-paul-post0"]);
  });

  it("makes no request at all when every reply span records its id", async () => {
    fake.spans.push(
      ...turnSpans({
        trace: "t1",
        agent: "paul",
        event: THREAD_C.root,
        root: THREAD_C.root,
        start: 0,
        end: 6,
        posts: [
          { replyTo: THREAD_C.root, text: "one", at: 1, eventId: hex("one") },
          { replyTo: THREAD_C.root, text: "two", at: 2, eventId: hex("two") },
        ],
      }).map((s) => restFromNode(s)),
    );
    const { spans } = await client().locateThread(THREAD_C.root, "ba");
    expect(spans.length).toBeGreaterThan(0);
    expect(asked()).toHaveLength(0);
  });

  it("makes no request when the thread has no reply span, or only reply calls that failed", async () => {
    fake.spans.push(
      ...turnSpans({
        trace: "t1",
        agent: "paul",
        event: THREAD_C.root,
        root: THREAD_C.root,
        start: 0,
        end: 6,
        tools: [{ name: "Bash", at: 1, params: { command: "ls" } }],
        posts: [{ replyTo: THREAD_C.root, text: "never posted", at: 2, error: true }],
      }).map((s) => restFromNode(s)),
    );
    await client().locateThread(THREAD_C.root, "ba");
    expect(asked()).toHaveLength(0);
  });

  it("asks about a shell call that posts with `buzz messages send`", async () => {
    fake.spans.push(
      ...turnSpans({
        trace: "t1",
        agent: "paul",
        event: THREAD_C.root,
        root: THREAD_C.root,
        start: 0,
        end: 6,
        tools: [{ name: "Bash", at: 1, params: { command: `buzz messages send --reply-to ${THREAD_C.root} --content "done"` } }],
      }).map((s) => restFromNode(s)),
    );
    await client().locateThread(THREAD_C.root, "ba");
    expect(asked()[0].query.getAll("span_ids")).toEqual(["t1-tool0"]);
  });

  it("makes no request for a thread that is not there", async () => {
    const found = await client().locateThread(hex("nobody"), "ba");
    expect(found.spans).toEqual([]);
    expect(asked()).toHaveLength(0);
  });
});

describe("a thread with many reply calls", () => {
  const manyReplies = (count: number) => {
    const spans = [restSpan({ trace: "a".repeat(32), name: "agent_turn", kind: "AGENT", start: "2026-11-08T04:46:12.000000+00:00", attributes: { "session.id": THREAD_C.root } })];
    for (let i = 0; i < count; i++) {
      spans.push(
        restSpan({
          trace: "a".repeat(32),
          name: "tool:mcp__buzz-thread__reply",
          kind: "TOOL",
          parent: "root",
          start: `2026-11-08T04:46:${String(13 + (i % 40)).padStart(2, "0")}.000000+00:00`,
          attributes: { "session.id": THREAD_C.root },
        }),
      );
    }
    return spans;
  };

  it("asks 50 spans at a time", async () => {
    fake.spans.push(...manyReplies(120));
    await client().locateThread(THREAD_C.root, "ba");
    expect(asked().map((c) => c.query.getAll("span_ids").length)).toEqual([50, 50, 20]);
    const all = asked().flatMap((c) => c.query.getAll("span_ids"));
    expect(new Set(all).size).toBe(120);
    expect(all.some((id) => id.includes(","))).toBe(false);
  });

  it("follows the cursor of a page that is cut short", async () => {
    const spans = manyReplies(5);
    fake.spans.push(...spans);
    spans.slice(1).forEach((s, i) => annotateRest(s.context.span_id, hex(`message-${i}`)));
    fake.annotationPageSize = 2;
    const found = await client().locateThread(THREAD_C.root, "ba");
    expect(asked()).toHaveLength(3);
    expect(asked().map((c) => c.query.get("cursor"))).toEqual([null, "2", "4"]);
    const labels = found.spans.flatMap((s) => s.annotations.map((a) => a.label)).sort();
    expect(labels).toEqual([0, 1, 2, 3, 4].map((i) => hex(`message-${i}`)).sort());
  });
});

describe("a Phoenix that does not answer for annotations", () => {
  beforeEach(() => {
    load(threadC());
    annotateRest("t1-kent-post0", THREAD_C.kentMessage);
  });

  it("is read as having none, when it has no such route (404): the thread is still read", async () => {
    fake.failWith = (call) => (call.path.endsWith("/span_annotations") ? new Response("Not Found", { status: 404 }) : null);
    const found = await client().locateThread(THREAD_C.root, "ba");
    expect(found.spans.length).toBeGreaterThan(0);
    expect(found.spans.flatMap((s) => s.annotations)).toEqual([]);
  });

  it("is an error when it fails otherwise: a posted id that cannot be read is not silently left out", async () => {
    fake.failWith = (call) => (call.path.endsWith("/span_annotations") ? new Response("boom", { status: 500, statusText: "Internal Server Error" }) : null);
    await expect(client().locateThread(THREAD_C.root, "ba")).rejects.toThrow(/HTTP 500/);
  });

  it("is an error when it refuses the credentials the spans were read with", async () => {
    fake.failWith = (call) => (call.path.endsWith("/span_annotations") ? new Response("Forbidden", { status: 403 }) : null);
    await expect(client().locateThread(THREAD_C.root, "ba")).rejects.toThrow(/HTTP 403/);
  });
});

describe("the old thread, completed in Phoenix with annotations, as the CLI reports it", () => {
  let out: string[];
  beforeEach(() => {
    vi.stubEnv("PHOENIX_URL", "http://phoenix.test:6006");
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    load(threadC());
    annotateRest("t1-kent-post0", THREAD_C.kentMessage);
    annotateRest("t2-paul-post0", THREAD_C.paulMessage);
    annotateRest("t3-paul-post0", hex("c-paul-answer"));
  });
  const printed = () => out.join("\n");

  it("inspect: names the turn that posted the message, shows every posted id, and has no ambiguous parent", async () => {
    expect(await main(["inspect", THREAD_C.root, "--project", "ba", "--no-color"])).toBe(0);
    const text = printed();
    const short = (id: string) => `${id.slice(0, 8)}…`;
    expect(text).toContain(`Reply To : message ${short(THREAD_C.kentMessage)} posted by Turn 1 (ba-kent-twin) — id from a span annotation`);
    expect(text).toContain(`Posted   : ${short(THREAD_C.kentMessage)} (span annotation)  "Kent Twin here`);
    expect(text).toContain(`Posted   : ${short(THREAD_C.paulMessage)} (span annotation)`);
    expect(text).toContain(`Posted   : ${short(hex("c-paul-answer"))} (span annotation)`);
    expect(text).not.toContain("which no span records as posted");
    expect(text).not.toContain("id not recorded");
    // 0.4.1's wording stays: a trace completed afterwards is still a trace in which steered messages were not recorded.
    expect(text).toContain("Handled  : 1 message — steered messages are not recorded in this trace");
  });

  it("--json: the parent is exact, its basis is the annotation, and there is no AMBIGUOUS_PARENT", async () => {
    expect(await main(["inspect", THREAD_C.root, "--project", "ba", "--json"])).toBe(0);
    const json = JSON.parse(out[0]);
    expect(json.turns[2].parent_message).toEqual({ id: THREAD_C.kentMessage, basis: "annotation", posted_by_turn: 1, turns: [1] });
    expect(json.turns[2].parent_edge).toBe("REPLY_TO");
    expect(json.turns.map((t: { posts: Array<{ event_id: string; event_id_source: string }> }) => t.posts[0].event_id_source)).toEqual(["annotation", "annotation", "annotation"]);
    expect(json.anomalies.map((a: { type: string }) => a.type)).not.toContain("AMBIGUOUS_PARENT");
  });

  it("takes five requests for a thread whose project it must find: the session, the projects, two for spans, one for annotations", async () => {
    await main(["query", THREAD_C.root, "--compact", "--json", "--flat"]);
    expect(fake.calls.map((c) => c.path)).toEqual([
      `/v1/sessions/${THREAD_C.root}`,
      "/v1/projects",
      "/v1/projects/ba/spans",
      "/v1/projects/ba/spans",
      "/v1/projects/ba/span_annotations",
    ]);
  });

  it("ignores an annotation whose label is no id: that parent is ambiguous again, as it was without it", async () => {
    fake.annotations.length = 0;
    annotateRest("t1-kent-post0", "not-an-id");
    annotateRest("t2-paul-post0", "not-an-id");
    await main(["inspect", THREAD_C.root, "--project", "ba", "--json"]);
    const json = JSON.parse(out[0]);
    expect(json.turns[2].parent_message.basis).toBe("ambiguous");
    expect(json.turns[2].parent_candidates).toEqual([1, 2]);
  });

  it("takes the latest annotation of a span: a later one replaces an earlier", async () => {
    annotateRest("t1-kent-post0", hex("corrected"), { identifier: "second-pass", updated_at: "2026-11-09T00:00:00+00:00" });
    await main(["inspect", THREAD_C.root, "--project", "ba", "--json"]);
    const json = JSON.parse(out[0]);
    expect(json.turns[0].posted_event_ids).toEqual([hex("corrected")]);
    // Nobody replies to the corrected id any more, so turn 3's parent is not the annotated message of turn 1.
    expect(json.turns[2].parent_message.basis).not.toBe("annotation");
  });
});
