/**
 * `buzz-trace transcript`, end to end: the whole path from the command line, through the REST API of a (fake) Phoenix, to the
 * text, Markdown or JSON a person or a program reads. A huddle thread of two agents: one asked to join and talked for a while,
 * one whose tool failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { SpanNode } from "../src/models.js";
import { FakePhoenix, restFromNode } from "./helpers/fake-phoenix.js";
import { hex } from "./helpers/phoenix-thread.js";
import { fxTurnSpans } from "./helpers/transcript-fixture.js";

const ROOT = hex("cli-root");
const SECOND = hex("cli-second");
const LONG = `${"A phantom is a structural grouping you never stock. ".repeat(6)}That is all.`;

const threadSpans = (): SpanNode[] => [
  ...fxTurnSpans({
    trace: "tr1",
    root: ROOT,
    event: ROOT,
    start: 0,
    end: 60,
    content: "@Kent Twin join the huddle",
    output: "Joined and answered.",
    llms: [{ at: 0.5, iteration: 1, asks: [{ id: "c-join", name: "meeting_join" }] }],
    tools: [
      { name: "meeting_join", at: 1, dur: 1, callId: "c-join", input: { url: "https://ba.example/huddle/1", display_name: "Kent Twin" }, output: { status: "joined" } },
      {
        name: "meeting_wait",
        at: 2,
        dur: 3,
        input: { timeout_seconds: 40 },
        output: { event: "addressed", heard: [{ at: "00:11", speaker: "Elio Tran", text: "What is a phantom assembly?", reason: "one_on_one" }], addressed: [] },
      },
      { name: "meeting_speak", at: 6, dur: 4, input: { text: LONG }, output: { spoken: true, result: "Finished speaking." } },
    ],
  }),
  ...fxTurnSpans({
    trace: "tr2",
    agent: "paul-twin",
    root: ROOT,
    event: SECOND,
    start: 100,
    end: 130,
    content: "@Paul Twin look something up",
    tools: [{ name: "knowledge_search", at: 105, status: "ERROR", statusMessage: "connection reset", input: { query: "bom" } }],
  }),
];

let fake: FakePhoenix;
let out: string[];
let err: string[];

beforeEach(() => {
  fake = new FakePhoenix().install();
  fake.sessions.push({ session_id: ROOT, project: "ba", start_time: "2026-11-08T04:46:12+00:00" });
  fake.spans.push(...threadSpans().map((s) => restFromNode(s)));
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

const printed = () => out.join("\n");

describe("buzz-trace transcript", () => {
  it("prints every request and response whole, for every turn, in order", async () => {
    expect(await main(["transcript", ROOT, "--no-color"])).toBe(0);
    const text = printed();
    expect(text).toContain("BUZZ-TRACE · Transcript");
    expect(text).toContain("Turn 1 · kent-twin");
    expect(text).toContain("Turn 2 · paul-twin");
    expect(text).toContain(`text: ${LONG}`);
    expect(text).toContain("text: What is a phantom assembly?");
    expect(text).toContain("error: connection reset");
    expect(text.indexOf("meeting_join")).toBeLessThan(text.indexOf("meeting_wait"));
    expect(text.indexOf("meeting_wait")).toBeLessThan(text.indexOf("meeting_speak"));
    expect(text.indexOf("meeting_speak")).toBeLessThan(text.indexOf("Turn 2"));
  });

  it("reads the thread with the requests the other commands make, and none more", async () => {
    await main(["transcript", ROOT, "--no-color"]);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v1/sessions/${ROOT}`,
      "GET /v1/projects",
      "GET /v1/projects/ba/spans",
      "GET /v1/projects/ba/spans",
    ]);
  });

  it("gives JSON with --json, and one line of it with --flat", async () => {
    expect(await main(["transcript", ROOT, "--json"])).toBe(0);
    const json = JSON.parse(out[0]);
    expect(json).toMatchObject({ view: "steps", thread_id: ROOT, project: "ba", total_turns: 2, shown_turns: 2 });
    expect(json.turns[0].steps[2].request).toEqual({ text: LONG });

    out.length = 0;
    expect(await main(["transcript", ROOT, "--flat"])).toBe(0);
    expect(out[0]).not.toContain("\n");
    expect(JSON.parse(out[0]).turns[1].steps[0]).toMatchObject({ name: "knowledge_search", status: "ERROR", error: "connection reset" });
  });

  it("gives Markdown with --markdown", async () => {
    expect(await main(["transcript", ROOT, "--markdown"])).toBe(0);
    expect(printed()).toContain("# Thread Transcript:");
    expect(printed()).toContain("### #3 `meeting_speak`");
  });

  it("gives only the conversation with --dialogue: what people said, and what the agent said, in order", async () => {
    expect(await main(["transcript", ROOT, "--dialogue", "--no-color"])).toBe(0);
    const text = printed();
    expect(text).toContain("BUZZ-TRACE · Dialogue");
    expect(text.indexOf("What is a phantom assembly?")).toBeLessThan(text.indexOf(LONG));
    expect(text).toContain("Elio Tran  · call 00:11");
    expect(text).toContain("Kent Twin  · said in the call · spoken in full");
    expect(text).not.toContain("meeting_wait");
  });

  it("gives the dialogue as JSON and as Markdown too", async () => {
    await main(["transcript", ROOT, "--dialogue", "--json"]);
    const json = JSON.parse(out[0]);
    expect(json).toMatchObject({ view: "dialogue", counts: { in: 3, out: 1 } });
    expect(json.lines.map((l: { speaker: string }) => l.speaker)).toEqual(["Elio Tran", "Elio Tran", "Kent Twin", "Elio Tran"]);

    out.length = 0;
    await main(["transcript", ROOT, "--dialogue", "--markdown"]);
    expect(printed()).toContain("# Thread Dialogue:");
    expect(printed()).toContain("> What is a phantom assembly?");
  });

  it("keeps to one turn with --turn, to the latest with --last, to an agent with --agent", async () => {
    await main(["transcript", ROOT, "--turn", "2", "--flat"]);
    expect(JSON.parse(out[0])).toMatchObject({ total_turns: 2, shown_turns: 1, turns: [{ turn_index: 2, agent: "paul-twin" }] });

    out.length = 0;
    await main(["transcript", ROOT, "--last", "1", "--flat"]);
    expect(JSON.parse(out[0]).turns.map((t: { turn_index: number }) => t.turn_index)).toEqual([2]);

    out.length = 0;
    await main(["transcript", ROOT, "--agent", "KENT", "--flat"]);
    expect(JSON.parse(out[0]).turns.map((t: { agent: string }) => t.agent)).toEqual(["kent-twin"]);
  });

  it("keeps to the steps of a tool with --tool, and to failed steps with --failures, numbering them as in the whole turn", async () => {
    await main(["transcript", ROOT, "--tool", "speak,wait", "--flat"]);
    const json = JSON.parse(out[0]);
    expect(json.turns[0].steps.map((s: { seq: number; name: string }) => [s.seq, s.name])).toEqual([
      [2, "meeting_wait"],
      [3, "meeting_speak"],
    ]);
    expect(json.turns[1].steps).toEqual([]);

    out.length = 0;
    await main(["transcript", ROOT, "--failures", "--flat"]);
    const failed = JSON.parse(out[0]);
    expect(failed.turns[0].steps).toEqual([]);
    expect(failed.turns[1].steps.map((s: { name: string }) => s.name)).toEqual(["knowledge_search"]);
  });

  it("says so when the filters leave no turn, and does not say the thread is missing", async () => {
    await main(["transcript", ROOT, "--turn", "9", "--no-color"]);
    expect(printed()).toContain("No turn matches the filters (the thread has 2)");
    expect(printed()).not.toContain("No agent turns recorded");
  });

  it("is not found in a project it is not in, and says where it looked", async () => {
    expect(await main(["transcript", ROOT, "--project", "mobile", "--flat"])).toBe(0);
    const json = JSON.parse(out[0]);
    expect(json.status).toBe("NOT_FOUND");
    expect(json.tried).toEqual(["http://phoenix.test:6006: no spans for it (looked in project mobile); the session exists in project ba"]);
    expect(json.turns).toEqual([]);
  });

  describe("refuses what it cannot do instead of answering something else", () => {
    it("needs a thread id", async () => {
      expect(await main(["transcript"])).toBe(1);
      expect(err.join("\n")).toContain("'transcript' requires a thread_id argument");
    });

    it("does not mix the dialogue with filters on steps", async () => {
      expect(await main(["transcript", ROOT, "--dialogue", "--tool", "speak"])).toBe(1);
      expect(err.join("\n")).toContain("--dialogue shows the conversation");
      err.length = 0;
      expect(await main(["transcript", ROOT, "--dialogue", "--failures"])).toBe(1);
      expect(err.join("\n")).toContain("--dialogue shows the conversation");
      expect(fake.calls).toEqual([]);
    });

    it("does not take --tool-input, which it does not filter on", async () => {
      expect(await main(["transcript", ROOT, "--tool-input", "bom"])).toBe(1);
      expect(err.join("\n")).toContain("--tool-input");
      expect(fake.calls).toEqual([]);
    });

    it("wants a positive whole number for --turn and --last", async () => {
      expect(await main(["transcript", ROOT, "--turn", "abc"])).toBe(1);
      expect(err.join("\n")).toContain("--turn must be a positive whole number");
      err.length = 0;
      expect(await main(["transcript", ROOT, "--last", "0"])).toBe(1);
      expect(err.join("\n")).toContain("--last must be a positive whole number");
      expect(fake.calls).toEqual([]);
    });
  });

  it("is listed in the help, with --dialogue", async () => {
    await main(["--help"]);
    expect(printed()).toContain("transcript <thread_id>");
    expect(printed()).toContain("--dialogue");
  });
});
