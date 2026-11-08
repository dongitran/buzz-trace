/**
 * The whole path with nothing but Phoenix's server behind it: no file, no relay. The CLI reads a thread through the REST API
 * of a (fake) Phoenix that has authentication on, finds the project from the thread, and reports parents, posted ids and
 * steering the way the contract records them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { FakePhoenix, restFromNode } from "./helpers/fake-phoenix.js";
import { hex, HUMAN, steerBlock, THREAD_C, threadC, turnSpans } from "./helpers/phoenix-thread.js";

const API_KEY = "fake-api-key-LIVE0001";
const EMAIL = "someone@example.test";
const PASSWORD = "fake-pass-word-LIVE0002";

let fake: FakePhoenix;
let out: string[];
let err: string[];

beforeEach(() => {
  fake = new FakePhoenix().install();
  fake.requireAuth = true;
  fake.apiKeys.add(API_KEY);
  fake.users.set(EMAIL, PASSWORD);
  fake.sessions.push({ session_id: THREAD_C.root, project: "ba", start_time: "2026-11-08T04:46:12+00:00" });
  vi.stubEnv("PHOENIX_URL", "http://phoenix.test:6006");
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const load = (spans: ReturnType<typeof threadC>) => fake.spans.push(...spans.map((s) => restFromNode(s)));
const printed = () => out.join("\n");

describe("an old thread, read from a Phoenix that wants an API key", () => {
  beforeEach(() => {
    vi.stubEnv("PHOENIX_API_KEY", API_KEY);
    load(threadC());
  });

  it("finds the project itself, and says who could have posted the parent message", async () => {
    expect(await main(["inspect", THREAD_C.root, "--no-color"])).toBe(0);
    const text = printed();
    expect(text).toContain("Project     : ba");
    expect(text).toContain(`Reply To : message ${THREAD_C.kentMessage.slice(0, 8)}… posted by Turn 1 or Turn 2: not recorded, so no parent is picked`);
    expect(text).toContain("Posted   : id not recorded");
    expect(text).toContain("Handled  : 1 message — steered messages are not recorded in this trace");
    expect(text).toContain("Source      : http://phoenix.test:6006");
  });

  it("takes five requests for a thread whose project it must find (the last asks for annotations of the reply spans), and signs in to nothing", async () => {
    await main(["query", THREAD_C.root, "--compact", "--json", "--flat"]);
    expect(fake.count("POST", "/auth/login")).toBe(0);
    expect(fake.calls.map((c) => c.path)).toEqual([
      `/v1/sessions/${THREAD_C.root}`,
      "/v1/projects",
      "/v1/projects/ba/spans",
      "/v1/projects/ba/spans",
      "/v1/projects/ba/span_annotations",
    ]);
    expect(fake.calls.every((c) => c.headers.authorization === `Bearer ${API_KEY}`)).toBe(true);
  });

  it("gives the same answer in compact JSON: candidates, the parent message, and that steering is not recorded", async () => {
    await main(["query", THREAD_C.root, "--compact", "--json", "--flat"]);
    const json = JSON.parse(out[0]);
    expect(json.steering).toBe("not_recorded");
    expect(json.turns[2]).toMatchObject({ turn: 3, edge: "ambiguous", candidates: [1, 2], parent_msg: THREAD_C.kentMessage.slice(0, 8) });
    expect(json.turns[2].parent).toBeUndefined();
  });

  it("is not found in a project it is not in, and says where it is", async () => {
    expect(await main(["query", THREAD_C.root, "--project", "mobile", "--compact", "--json", "--flat"])).toBe(0);
    const json = JSON.parse(out[0]);
    expect(json.status).toBe("NOT_FOUND");
    expect(json.tried).toEqual([`http://phoenix.test:6006: no spans for it (looked in project mobile); the session exists in project ba`]);
  });

  it("lists the newest sessions of every project", async () => {
    fake.sessions.push({ session_id: hex("mobile-1"), project: "mobile", start_time: "2026-11-08T09:00:00+00:00" });
    expect(await main(["sessions", "--limit", "5"])).toBe(0);
    const text = printed();
    expect(text).toContain("Project: all projects");
    expect(text).toMatch(/\[01\] Session: 0*[0-9a-f]+ · Project: mobile/);
    expect(text).toContain(`Session: ${THREAD_C.root} · Project: ba`);
  });
});

describe("a thread recorded under the contract", () => {
  beforeEach(() => {
    vi.stubEnv("PHOENIX_API_KEY", API_KEY);
    const { root, kentMessage, followUp } = THREAD_C;
    load([
      ...threadC({ kentId: true, paulId: true }),
      ...turnSpans({
        trace: "t4-paul",
        agent: "ba-paul-twin",
        event: hex("c-fourth"),
        replyTo: followUp,
        root,
        start: 30,
        end: 50,
        steers: [
          { eventId: hex("c-steer-1"), text: "Also keep it to one sentence.", at: 34, sender: "Elio Tran", priority: "now" },
          { eventId: hex("c-steer-2"), text: "And name the domain first.", at: 38, priority: "later", as: "event" },
        ],
        posts: [{ replyTo: hex("c-fourth"), text: "Done.", at: 45, output: `posted (5 characters) · event_id ${hex("c-fourth-msg")}` }],
      }),
    ]);
    void kentMessage;
  });

  it("reports the posted ids, the exact parents, and the steered messages", async () => {
    expect(await main(["inspect", THREAD_C.root, "--no-color"])).toBe(0);
    const text = printed();
    expect(text).toContain(`Posted   : ${THREAD_C.kentMessage.slice(0, 8)}…  "Kent Twin here`);
    expect(text).toContain(`Reply To : message ${THREAD_C.kentMessage.slice(0, 8)}… posted by Turn 1 (ba-kent-twin)`);
    expect(text).toContain("Handled  : 3 messages (2 steered)");
    expect(text).toContain(`↳ steered ${hex("c-steer-1").slice(0, 8)}… (now) "Also keep it to one sentence."`);
    expect(text).toContain(`↳ steered ${hex("c-steer-2").slice(0, 8)}… (later) "And name the domain first."`);
    expect(text).toContain(`Posted   : ${hex("c-fourth-msg").slice(0, 8)}…  "Done."`);
    expect(text).not.toContain("steered messages are not recorded");
  });

  it("gives them in the full JSON with their full ids", async () => {
    await main(["inspect", THREAD_C.root, "--json"]);
    const json = JSON.parse(out[0]);
    expect(json.project).toBe("ba");
    expect(json.steering).toBe("recorded");
    const fourth = json.turns[3];
    expect(fourth.posted_event_ids).toEqual([hex("c-fourth-msg")]);
    expect(fourth.handled_messages).toBe(3);
    expect(fourth.steered.map((m: { event_id: string }) => m.event_id)).toEqual([hex("c-steer-1"), hex("c-steer-2")]);
    expect(json.turns[2].parent_message).toEqual({ id: THREAD_C.kentMessage, basis: "posted", posted_by_turn: 1, turns: [1] });
  });
});

describe("a turn the Buzz fork recorded, steers and all", () => {
  beforeEach(() => {
    vi.stubEnv("PHOENIX_API_KEY", API_KEY);
    const root = THREAD_C.root;
    load(
      turnSpans({
        trace: "f1",
        agent: "ba-paul-twin",
        event: root,
        root,
        start: 0,
        end: 16,
        steers: [
          { eventId: hex("f-m1"), text: steerBlock({ eventId: hex("f-m1"), root, content: "@Paul Twin Separate question: which SAP table holds material descriptions?" }), at: 3, priority: "now", delivered: true, endReason: "echo", senderPubkey: HUMAN },
          { eventId: hex("f-m2"), text: steerBlock({ eventId: hex("f-m2"), root, content: "@Paul Twin too late for this one" }), at: 15, priority: "now", delivered: false, endReason: "turn_end", senderPubkey: HUMAN },
        ],
        posts: [{ replyTo: root, text: "MAKT is the table of material descriptions.", at: 8, eventId: hex("f-post") }],
      }),
    );
  });

  it("reads the question from the block, counts what was delivered, and does not call the trace unrecorded", async () => {
    expect(await main(["inspect", THREAD_C.root, "--no-color"])).toBe(0);
    const text = printed();
    expect(text).toContain("Handled  : 2 messages (1 steered)");
    expect(text).toContain(`↳ steered ${hex("f-m1").slice(0, 8)}… (now) "@Paul Twin Separate question: which SAP table holds material descriptions?"`);
    expect(text).toContain(`↳ not delivered ${hex("f-m2").slice(0, 8)}… (now) "@Paul Twin too late for this one" — the turn ended before it reached it`);
    expect(text).toContain(`Posted   : ${hex("f-post").slice(0, 8)}…  "MAKT is the table of material descriptions."`);
    expect(text).not.toContain("not recorded");
    expect(text).not.toContain("arrived while you were working");
  });

  it("keeps that answer when only the last turn is asked for", async () => {
    await main(["query", THREAD_C.root, "--last", "1", "--compact", "--json", "--flat"]);
    const json = JSON.parse(out[0]);
    expect(json.steering).toBeUndefined();
    expect(json.turns[0].msgs).toBe(2);
    expect(json.turns[0].not_delivered).toHaveLength(1);
  });
});

describe("signing in", () => {
  beforeEach(() => {
    vi.stubEnv("PHOENIX_EMAIL", EMAIL);
    vi.stubEnv("PHOENIX_PASSWORD", PASSWORD);
    load(threadC());
  });

  it("is done once for a command that reads two threads", async () => {
    expect(await main(["diff", `${THREAD_C.root}#1`, `${THREAD_C.root}#2`, "--flat"])).toBe(0);
    expect(fake.count("POST", "/auth/login")).toBe(1);
    expect(fake.of(/^\/v1\//).every((c) => c.headers.authorization === "Bearer access-1")).toBe(true);
  });

  it("never prints the password or the email", async () => {
    await main(["inspect", THREAD_C.root, "--no-color"]);
    expect(out.join("\n") + err.join("\n")).not.toMatch(/fake-pass-word|someone@example/);
  });
});

describe("nothing to authenticate with", () => {
  it("exits 2 and says what to set, never reporting the thread as not found", async () => {
    load(threadC());
    expect(await main(["inspect", THREAD_C.root, "--no-color"])).toBe(2);
    expect(err.join("\n")).toMatch(/PHOENIX_API_KEY/);
    expect(err.join("\n")).toMatch(/PHOENIX_EMAIL and PHOENIX_PASSWORD/);
    expect(printed()).not.toContain("NOT_FOUND");
  });
});

describe("--db is gone", () => {
  it("says why, and what to set, and reads nothing", async () => {
    expect(await main(["inspect", THREAD_C.root, "--db", "phoenix.db"])).toBe(1);
    expect(err.join("\n")).toBe("Error: --db was removed in 0.4.0: buzz-trace reads the Phoenix server. Set PHOENIX_ENDPOINT (or PHOENIX_URL), or pass --endpoint.");
    expect(fake.calls).toEqual([]);
  });

  it("is not in the help, and neither is a database", async () => {
    await main(["--help"]);
    expect(printed()).not.toMatch(/--db|sqlite|database/i);
  });
});

describe("--messages is gone", () => {
  it("is an argument error, not a silently ignored option", async () => {
    expect(await main(["inspect", THREAD_C.root, "--messages", "thread.json"])).toBe(1);
    expect(err.join("\n")).toContain("Unknown option '--messages'");
  });

  it("is not in the help", async () => {
    await main(["--help"]);
    expect(printed()).not.toContain("--messages");
    expect(printed()).toContain("PHOENIX_EMAIL");
  });
});
