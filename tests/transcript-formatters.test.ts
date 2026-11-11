/**
 * What the transcript looks like to a person (terminal, Markdown) and to a program (JSON). The point of every test here is that
 * nothing is cut: the text of a request and of a response arrives whole, and what the telemetry itself lacks is said, not hidden.
 */
import { describe, expect, it } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { extractDialogue } from "../src/engine/dialogue.js";
import { TranscriptBuilder, type Transcript, type TranscriptOptions } from "../src/engine/transcript.js";
import { TranscriptRenderer } from "../src/formatters/transcript-fmt.js";
import { ThreadTelemetry, type SpanNode } from "../src/models.js";
import { hex } from "./helpers/phoenix-thread.js";
import { fxTurnSpans, type FxTurn } from "./helpers/transcript-fixture.js";

const ROOT = hex("formatter-root");
const LONG = `${"A phantom is a structural grouping you never stock. ".repeat(6)}That is all.`;
const MESSAGE = "Hi Kent.\nPlease join the huddle.";

const turn = (over: Partial<FxTurn> = {}): FxTurn => ({
  trace: "tr1",
  root: ROOT,
  event: ROOT,
  start: 0,
  end: 120,
  content: MESSAGE,
  sender: "Elio Tran",
  output: "All done.",
  llms: [
    { at: 0.5, iteration: 1, asks: [{ id: "c-join", name: "meeting_join" }] },
    { at: 4, iteration: 2, asks: [{ id: "c-speak", name: "meeting_speak" }] },
    { at: 100, iteration: 3, text: "Wrapping up." },
  ],
  tools: [
    { name: "meeting_join", at: 1, dur: 1, callId: "c-join", input: { url: "https://ba.example/huddle/1", display_name: "Kent Twin" }, output: { status: "joined" } },
    { name: "meeting_speak", at: 5, dur: 2, callId: "c-speak", input: { text: LONG }, output: { spoken: true, result: 'Interrupted by Elio Tran. Spoken until now: "A phantom"' } },
    { name: "knowledge_search", at: 8, dur: 1, input: { query: "bom" }, output: "x".repeat(8207), bytes: 12098 },
    { name: "knowledge_search", at: 10, status: "ERROR", statusMessage: "connection reset", input: { query: "mrp" } },
  ],
  steers: [{ at: 6, eventId: hex("steered"), text: "Keep it short.", sender: "Elio Tran" }],
  ...over,
});

function transcriptOf(spans: SpanNode[], options?: TranscriptOptions): Transcript {
  const telemetry = new ThreadAggregator(ROOT, "ba").aggregate(spans);
  telemetry.source = "http://phoenix.test:6006";
  telemetry.phoenixSessionUrl = `http://phoenix.test:6006/redirects/sessions/${ROOT}`;
  return new TranscriptBuilder().build(telemetry, options);
}

const plain = new TranscriptRenderer(false);

describe("the transcript in a terminal", () => {
  const text = () => plain.terminal(transcriptOf(fxTurnSpans(turn())));

  it("shows a request and a response whole, past 80 characters, with the line breaks the message had", () => {
    expect(LONG.length).toBeGreaterThan(300);
    expect(text()).toContain(`text: ${LONG}`);
    expect(text()).toContain("│   Hi Kent.\n  │   Please join the huddle.");
    expect(text()).toContain("result: Interrupted by Elio Tran. Spoken until now: \"A phantom\"");
  });

  it("numbers each step and says when it ran, what it was, how it ended, how long it took and which model call asked for it", () => {
    expect(text()).toContain("#1  04:46:13.000Z  meeting_join  ✓  1000ms  (model call 1)");
    expect(text()).toContain("#2  04:46:17.000Z  meeting_speak  ✓  2000ms  (model call 2)");
  });

  it("puts a steered message and the model's words among the steps, in the order they happened", () => {
    const out = text();
    expect(out).toContain("#3  04:46:18.000Z  steer from Elio Tran");
    expect(out).toContain("Keep it short.");
    expect(out).toContain("#6  04:47:52.000Z  assistant  (model call 3)");
    expect(out).toContain("Wrapping up.");
    expect(out.indexOf("#2 ")).toBeLessThan(out.indexOf("#3 "));
    expect(out.indexOf("#5 ")).toBeLessThan(out.indexOf("#6 "));
  });

  it("says what the runtime cut of a response, in bytes", () => {
    expect(text()).toContain("response cut by the runtime: recorded 8,207 of 12,098 bytes");
  });

  it("marks a failed step and says why", () => {
    const out = text();
    expect(out).toContain("#5  04:46:22.000Z  knowledge_search  ✗");
    expect(out).toContain("error: connection reset");
    expect(out).toContain("response: (not recorded)");
  });

  it("shows the turn's closing text after its steps", () => {
    const out = text();
    expect(out).toContain("All done.");
    expect(out.indexOf("Wrapping up.")).toBeLessThan(out.indexOf("All done."));
  });

  it("says that a turn whose agent_turn span was never exported has no agent, no end and no closing text", () => {
    const out = plain.terminal(transcriptOf(fxTurnSpans(turn({ rootless: true, steers: [], output: undefined }))));
    expect(out).toContain("Turn 1 · (agent not recorded) · deepseek-flash");
    expect(out).toContain("no agent_turn span was exported for this trace");
    expect(out).not.toContain("Output");
  });

  it("gives the prompt and a line per model call only when asked for the detail", () => {
    const t = transcriptOf(fxTurnSpans(turn()), { verbose: true });
    const out = plain.terminal(t, { verbose: true });
    expect(out).toContain("[Agent Memory — core]");
    expect(out).toContain("model call 2 · deepseek-flash · 1000 → 20 tokens");
    expect(text()).not.toContain("[Agent Memory — core]");
    expect(text()).not.toContain("model call 2 · deepseek-flash");
  });

  it("writes no escape codes without colours, and some with them", () => {
    expect(text()).toContain("meeting_join");
    expect(text()).not.toContain("\u001b[");
    const saved = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      expect(new TranscriptRenderer(true).terminal(transcriptOf(fxTurnSpans(turn())))).toContain("\u001b[");
      process.env.NO_COLOR = "1";
      expect(new TranscriptRenderer(true).terminal(transcriptOf(fxTurnSpans(turn())))).not.toContain("\u001b[");
    } finally {
      if (saved === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = saved;
      }
    }
  });

  it("says where a thread was looked for when it is not there", () => {
    const t = new ThreadTelemetry({ threadId: ROOT, project: null, status: "NOT_FOUND", sourcesTried: ["http://phoenix.test:6006: no spans for it"] });
    const out = plain.terminal(new TranscriptBuilder().build(t));
    expect(out).toContain("NOT_FOUND");
    expect(out).toContain("No agent turns recorded for this thread");
    expect(out).toContain("http://phoenix.test:6006: no spans for it");
  });
});

// ── the dialogue ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const heardLine = (at: string, speaker: string, text: string, reason = "one_on_one") => ({ at, speaker, text, reason });
const gateWait = (...lines: Array<ReturnType<typeof heardLine>>) => ({ state: "in_meeting", event: "addressed", heard: lines, addressed: lines });

const huddle = (over: Partial<FxTurn> = {}): FxTurn =>
  turn({
    content: "@Kent Twin join the huddle",
    llms: [],
    steers: [],
    output: undefined,
    tools: [
      { name: "meeting_join", at: 1, dur: 1, input: { url: "https://ba.example/huddle/1", display_name: "Kent Twin" }, output: { status: "joined" } },
      { name: "meeting_wait", at: 2, dur: 3, input: { timeout_seconds: 40 }, output: gateWait(heardLine("00:11", "Elio Tran", "Hi. Kent.", "mention")) },
      { name: "meeting_speak", at: 6, dur: 2, input: { text: "Hi Elio, this is Kent Twin. I'm here." }, output: { spoken: true, result: 'Interrupted by Elio Tran. Spoken until now: "Hi Elio"' } },
      { name: "meeting_speak", at: 12, dur: 3, input: { text: LONG }, output: { spoken: true, result: "Finished speaking." } },
    ],
    ...over,
  });

const dialogueText = (over: Partial<FxTurn> = {}) => {
  const t = transcriptOf(fxTurnSpans(huddle(over)));
  return { t, lines: extractDialogue(t) };
};

describe("the dialogue in a terminal", () => {
  it("shows each line with its time, its speaker, how it reached the agent or what became of it, and its whole text", () => {
    const { t, lines } = dialogueText();
    const out = plain.dialogueTerminal(t, lines);
    expect(out).toContain("04:46:12.000Z  Elio Tran  · message\n      @Kent Twin join the huddle");
    expect(out).toContain("04:46:17.000Z  Elio Tran  · call 00:11 · mention\n      Hi. Kent.");
    expect(out).toContain("04:46:18.000Z  Kent Twin  · said in the call · cut off by Elio Tran after “Hi Elio”\n      Hi Elio, this is Kent Twin. I'm here.");
    expect(out).toContain(`04:46:24.000Z  Kent Twin  · said in the call · spoken in full\n      ${LONG}`);
  });

  it("counts the lines, in and out", () => {
    const { t, lines } = dialogueText();
    expect(plain.dialogueTerminal(t, lines)).toContain("1 shown of 1 · 4 lines (2 in · 2 out)");
  });

  it("says that a turn without an agent_turn span has no known agent", () => {
    const { t, lines } = dialogueText({ rootless: true });
    const out = plain.dialogueTerminal(t, lines);
    expect(out).toContain("Turn 1 · (agent not recorded)");
    expect(out).toContain("no agent_turn span was exported for this trace");
  });

  it("says where a thread was looked for when it is not there", () => {
    const t = new TranscriptBuilder().build(new ThreadTelemetry({ threadId: ROOT, project: null, status: "NOT_FOUND", sourcesTried: ["http://phoenix.test:6006: no spans for it"] }));
    const out = plain.dialogueTerminal(t, []);
    expect(out).toContain("NOT_FOUND");
    expect(out).toContain("http://phoenix.test:6006: no spans for it");
  });
});

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the transcript as Markdown", () => {
  const md = () => plain.markdown(transcriptOf(fxTurnSpans(turn())));

  it("has a title, a table of the thread's facts, a heading per turn and a heading per step", () => {
    const out = md();
    expect(out).toContain(`# Thread Transcript: \`${ROOT.slice(0, 16)}...\``);
    expect(out).toContain("| **Project** | `ba` |");
    expect(out).toContain("## Turn 1 — `kent-twin` · `deepseek-flash` · OK");
    expect(out).toContain("### #1 `meeting_join` ✓ · `04:46:13.000Z` · 1000ms · model call 1");
    expect(out).toContain("### #5 `knowledge_search` ✗ · `04:46:22.000Z` · 500ms");
  });

  it("gives a request and a response whole, each in a fence", () => {
    const out = md();
    expect(out).toContain("**Request**\n\n```text\nurl: https://ba.example/huddle/1\ndisplay_name: Kent Twin\n```");
    expect(out).toContain("**Response**\n\n```text\nstatus: joined\n```");
    expect(out).toContain(`text: ${LONG}`);
  });

  it("fences with more backticks than the longest run inside the text, so the text cannot close its own fence", () => {
    const spans = fxTurnSpans(turn({ llms: [], steers: [], tools: [{ name: "meeting_transcript", at: 5, input: {}, output: "before\n```json\n{}\n```\nafter" }] }));
    const out = plain.markdown(transcriptOf(spans));
    expect(out).toContain("````text\nbefore\n```json\n{}\n```\nafter\n````");
  });

  it("says what the runtime cut, what failed, and that a turn has no agent_turn span", () => {
    const out = md();
    expect(out).toContain("> response cut by the runtime: recorded 8,207 of 12,098 bytes");
    expect(out).toContain("> error: connection reset");
    const rootless = plain.markdown(transcriptOf(fxTurnSpans(turn({ rootless: true, steers: [], output: undefined }))));
    expect(rootless).toContain("> no agent_turn span was exported for this trace");
    expect(rootless).toContain("## Turn 1 — (agent not recorded) · `deepseek-flash` · OK");
  });

  it("gives the dialogue as quotes, speaker and time first", () => {
    const { t, lines } = dialogueText();
    const out = plain.dialogueMarkdown(t, lines);
    expect(out).toContain(`# Thread Dialogue: \`${ROOT.slice(0, 16)}...\``);
    expect(out).toContain("**Elio Tran** · `04:46:17.000Z` · call 00:11 · mention\n\n> Hi. Kent.");
    expect(out).toContain("**Kent Twin** · `04:46:18.000Z` · said in the call · cut off by Elio Tran after “Hi Elio”\n\n> Hi Elio, this is Kent Twin. I'm here.");
  });

  it("quotes every line of a message that has several, blank ones too", () => {
    const { t, lines } = dialogueText({ content: "First line.\n\nThird line." });
    expect(plain.dialogueMarkdown(t, lines)).toContain("> First line.\n>\n> Third line.");
  });
});

// ── JSON ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the transcript as JSON", () => {
  const json = () => JSON.parse(plain.json(transcriptOf(fxTurnSpans(turn()))));

  it("describes the thread and each turn", () => {
    const t = json();
    expect(t).toMatchObject({ view: "steps", thread_id: ROOT, project: "ba", session_id: ROOT, status: "OK", total_turns: 1, shown_turns: 1, source: "http://phoenix.test:6006" });
    expect(t.turns[0]).toMatchObject({
      turn_index: 1,
      trace_id: "tr1",
      agent: "kent-twin",
      model: "deepseek-flash",
      status: "OK",
      root_span: true,
      start_time: "2026-11-08T04:46:12.000Z",
      end_time: "2026-11-08T04:48:12.000Z",
      duration_ms: 120000,
      event_id: ROOT,
      request: { from: "Elio Tran", message: MESSAGE },
      output: "All done.",
    });
    expect(t.turns[0].request.prompt).toContain("[Buzz event: @mention]");
  });

  it("gives a request or a response as the JSON value it is, else as the text, else null, with nothing cut", () => {
    const steps = json().turns[0].steps;
    expect(steps[1]).toMatchObject({ seq: 2, type: "tool", name: "meeting_speak", call_id: "c-speak", model_call: 2, status: "OK", error: null, duration_ms: 2000 });
    expect(steps[1].request).toEqual({ text: LONG });
    expect(steps[1].response).toEqual({ spoken: true, result: 'Interrupted by Elio Tran. Spoken until now: "A phantom"' });
    expect(steps[3].response).toBe("x".repeat(8207));
    expect(steps[4].response).toBeNull();
  });

  it("says what the runtime cut, in the bytes it recorded and the bytes the tool returned", () => {
    const steps = json().turns[0].steps;
    expect(steps[3]).toMatchObject({ response_truncated: true, response_recorded_bytes: 8207, response_returned_bytes: 12098 });
    expect(steps[0]).toMatchObject({ response_truncated: false, response_recorded_bytes: 19, response_returned_bytes: null });
  });

  it("types each kind of step and keeps its own fields", () => {
    const steps = json().turns[0].steps;
    expect(steps[2]).toMatchObject({ seq: 3, type: "steer", sender: "Elio Tran", text: "Keep it short.", delivered: null, start_time: "2026-11-08T04:46:18.000Z" });
    expect(steps[5]).toMatchObject({ seq: 6, type: "assistant", model_call: 3, text: "Wrapping up." });
  });

  it("does not invent an agent, an end or a closing text for a trace without its agent_turn span", () => {
    const t = JSON.parse(plain.json(transcriptOf(fxTurnSpans(turn({ rootless: true, steers: [], output: undefined })))));
    expect(t.turns[0]).toMatchObject({ agent: null, root_span: false, output: null });
  });

  it("is on one line when asked for no indentation, and still whole", () => {
    const flat = plain.json(transcriptOf(fxTurnSpans(turn())), 0);
    expect(flat).not.toContain("\n");
    expect(JSON.parse(flat).turns[0].steps[1].request).toEqual({ text: LONG });
  });

  it("gives the dialogue as lines with the same keys each time, nulls where a line has nothing to say", () => {
    const { t, lines } = dialogueText();
    const json = JSON.parse(plain.dialogueJson(t, lines));
    expect(json).toMatchObject({ view: "dialogue", thread_id: ROOT, total_turns: 1, shown_turns: 1, counts: { in: 2, out: 2 } });
    expect(json.lines[2]).toEqual({
      turn: 1,
      time: "2026-11-08T04:46:18.000Z",
      direction: "out",
      channel: "meeting",
      via: "meeting_speak",
      speaker: "Kent Twin",
      text: "Hi Elio, this is Kent Twin. I'm here.",
      offset: null,
      reason: null,
      event_id: null,
      outcome: "interrupted",
      interrupted_by: "Elio Tran",
      spoken: "Hi Elio",
      result: 'Interrupted by Elio Tran. Spoken until now: "Hi Elio"',
    });
    expect(json.lines[1]).toMatchObject({ direction: "in", via: "meeting_wait", speaker: "Elio Tran", offset: "00:11", reason: "mention", outcome: null });
  });
});

describe("a transcript whose filters left no turn", () => {
  // the thread has one turn; the filters dropped it
  const filtered = () => ({ ...transcriptOf(fxTurnSpans(turn())), turns: [] });

  it("says that no turn matches, and not that the thread is missing, in every form", () => {
    const t = filtered();
    for (const out of [plain.terminal(t), plain.dialogueTerminal(t, []), plain.markdown(t), plain.dialogueMarkdown(t, [])]) {
      expect(out).toContain("No turn matches the filters (the thread has 1)");
      expect(out).not.toContain("No agent turns recorded");
      expect(out).not.toContain("Looked in");
    }
  });

  it("keeps the thread's facts and the number of turns it has in the JSON", () => {
    const json = JSON.parse(plain.json(filtered()));
    expect(json).toMatchObject({ status: "OK", total_turns: 1, shown_turns: 0, turns: [] });
  });
});

describe("text that could drive the reader's terminal", () => {
  const hostile = () =>
    transcriptOf(
      fxTurnSpans(
        turn({
          llms: [],
          steers: [],
          output: "bye\u001b]0;pwned\u0007",
          tools: [{ name: "web_fetch", at: 5, input: { url: "https://x.example/\u001b[2J" }, output: "\u001b[31mred\u001b[0m\rOVERWRITE\ttabbed" }],
        }),
      ),
    );

  it("is shown as escapes, not sent, in a terminal and in Markdown", () => {
    for (const out of [plain.terminal(hostile()), plain.markdown(hostile())]) {
      expect(out).not.toContain("\u001b");
      expect(out).not.toContain("\u0007");
      expect(out).not.toContain("\r");
      expect(out).toContain("\\x1b[31mred\\x1b[0m");
      expect(out).toContain("OVERWRITE\ttabbed");
      expect(out).toContain("url: https://x.example/\\x1b[2J");
      expect(out).toContain("bye\\x1b]0;pwned\\x07");
    }
  });

  it("is shown as escapes in the dialogue too, speaker names included", () => {
    const t = transcriptOf(fxTurnSpans(huddle({ sender: "Eve\u001b[2J", content: "hi\u001b[H" })));
    const lines = extractDialogue(t);
    for (const out of [plain.dialogueTerminal(t, lines), plain.dialogueMarkdown(t, lines)]) {
      expect(out).not.toContain("\u001b");
      expect(out).toContain("Eve\\x1b[2J");
      expect(out).toContain("hi\\x1b[H");
    }
  });

  it("is kept exactly in JSON", () => {
    const step = JSON.parse(plain.json(hostile())).turns[0].steps[0];
    expect(step.response).toBe("\u001b[31mred\u001b[0m\rOVERWRITE\ttabbed");
    expect(step.request).toEqual({ url: "https://x.example/\u001b[2J" });
  });
});

describe("a message that started more than one turn", () => {
  const twice = () => {
    // a restart: the same message started a second turn
    const t = transcriptOf([...fxTurnSpans(huddle()), ...fxTurnSpans(huddle({ trace: "tr2", start: 200, end: 260, tools: [] }))]);
    return { t, lines: extractDialogue(t) };
  };

  it("is listed again under the later turn, and said to be the same message", () => {
    const { t, lines } = twice();
    for (const out of [plain.dialogueTerminal(t, lines), plain.dialogueMarkdown(t, lines)]) {
      expect(out.match(/message · same message as turn 1/g)).toHaveLength(1);
      expect(out.match(/@Kent Twin join the huddle/g)).toHaveLength(2);
    }
  });

  it("is told apart in JSON by its event id", () => {
    const { t, lines } = twice();
    const messages = JSON.parse(plain.dialogueJson(t, lines)).lines.filter((l: { via: string }) => l.via === "message");
    expect(messages.map((m: { turn: number; event_id: string }) => [m.turn, m.event_id])).toEqual([
      [1, ROOT],
      [2, ROOT],
    ]);
  });
});
