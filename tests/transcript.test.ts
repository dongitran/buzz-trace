/**
 * The transcript: what each step asked and what came back, whole, in the order it ran. The other commands keep 80 characters of a
 * tool's input and never read its output; the transcript must give both without a cap, and say honestly where the telemetry
 * itself holds less than the tool returned.
 */
import { describe, expect, it } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { decodePayload, TranscriptBuilder, type ToolStep, type TranscriptOptions } from "../src/engine/transcript.js";
import type { SpanNode } from "../src/models.js";
import { hex } from "./helpers/phoenix-thread.js";
import { fxTurnSpans, type FxTurn } from "./helpers/transcript-fixture.js";

const ROOT = hex("transcript-root");

const turn = (over: Partial<FxTurn> = {}): FxTurn => ({ trace: "tr1", root: ROOT, event: ROOT, start: 0, end: 60, ...over });

function transcriptOf(spans: SpanNode[], options?: TranscriptOptions) {
  return new TranscriptBuilder().build(new ThreadAggregator(ROOT, "ba").aggregate(spans), options);
}

const toolSteps = (spans: SpanNode[], options?: TranscriptOptions): ToolStep[] =>
  transcriptOf(spans, options).turns[0].steps.filter((s): s is ToolStep => s.type === "tool");

describe("decodePayload", () => {
  it("keeps the recorded text byte for byte and reads the JSON out of it", () => {
    // odd spacing, escapes and the white space around it on purpose: a pretty-printer, a re-serializer or a trim would change the text
    const raw = '\n  {"text":  "it\'s \\"quoted\\"",\n "n":1}  \n';
    const payload = decodePayload(raw);
    expect(payload?.text).toBe(raw);
    expect(payload?.json).toEqual({ text: 'it\'s "quoted"', n: 1 });
  });

  it("leaves plain text, a bare number and cut-off JSON as text, and does not throw on them", () => {
    expect(decodePayload("hello")?.json).toBeUndefined();
    expect(decodePayload("42")?.json).toBeUndefined();
    expect(decodePayload('{"text":"cut off in the mid')).toEqual({ text: '{"text":"cut off in the mid', bytes: 27 });
  });

  it("measures UTF-8 bytes, which are more than the characters for accents and dashes", () => {
    // h é l l o ␠ — ␠ o k : 10 characters, 13 bytes
    expect(decodePayload("héllo — ok")?.bytes).toBe(13);
  });

  it("is null for what a runtime did not record, and empty text for what it recorded as empty", () => {
    expect(decodePayload(undefined)).toBeNull();
    expect(decodePayload(null)).toBeNull();
    expect(decodePayload("")).toEqual({ text: "", bytes: 0 });
  });
});

describe("a tool step", () => {
  it("has the whole request and the whole response, past the 80 characters the other commands keep", () => {
    const text = `${"Straight answer: a phantom is a structural grouping. ".repeat(12)}END`;
    const [step] = toolSteps(
      fxTurnSpans(turn({ tools: [{ name: "meeting_speak", at: 10, dur: 2, input: { text }, output: { spoken: true, result: "Finished speaking." } }] })),
    );

    expect(step.name).toBe("meeting_speak");
    expect(step.request?.text).toBe(JSON.stringify({ text }));
    expect(step.request?.json).toEqual({ text });
    expect(step.request?.text.length).toBeGreaterThan(600);
    expect(step.response?.json).toEqual({ spoken: true, result: "Finished speaking." });
    expect(step.at?.toISOString()).toBe("2026-11-08T04:46:22.000Z");
    expect(step.end?.toISOString()).toBe("2026-11-08T04:46:24.000Z");
    expect(step.durationMs).toBe(2000);
    expect(step.status).toBe("OK");
    expect(step.error).toBeNull();
  });

  it("reads a response that is plain text as text", () => {
    const [step] = toolSteps(
      fxTurnSpans(turn({ tools: [{ name: "meeting_transcript", at: 5, input: { minutes: 6 }, output: "… (earlier lines omitted)\n[09:45] Kent Twin (you): First I'd pin down the field" }] })),
    );
    expect(step.response?.text).toBe("… (earlier lines omitted)\n[09:45] Kent Twin (you): First I'd pin down the field");
    expect(step.response?.json).toBeUndefined();
  });

  it("is failed when the span is an error, with the reason the span gives", () => {
    const [step] = toolSteps(fxTurnSpans(turn({ tools: [{ name: "knowledge_search", at: 5, status: "ERROR", statusMessage: "connection reset", input: { query: "bom" } }] })));
    expect(step.status).toBe("ERROR");
    expect(step.error).toBe("connection reset");
  });

  it("is failed too when the tool says it failed but the span is OK", () => {
    const [step] = toolSteps(fxTurnSpans(turn({ tools: [{ name: "knowledge_search", at: 5, isError: true, input: { query: "bom" }, output: "no such collection" }] })));
    expect(step.status).toBe("ERROR");
    expect(step.error).toBeNull();
    expect(step.response?.text).toBe("no such collection");
  });

  it("says when the telemetry holds fewer bytes of the response than the tool returned", () => {
    const [cut, whole] = toolSteps(
      fxTurnSpans(
        turn({
          tools: [
            { name: "knowledge_search", at: 5, input: { query: "bom" }, output: "x".repeat(8207), bytes: 12098 },
            { name: "knowledge_search", at: 8, input: { query: "bom" }, output: "y".repeat(100) },
          ],
        }),
      ),
    );
    expect(cut.response?.bytes).toBe(8207);
    expect(cut.responseTruncated).toBe(true);
    expect(cut.responseBytes).toBe(12098);
    expect(whole.responseTruncated).toBe(false);
    expect(whole.responseBytes).toBeNull();
  });

  it("is not called truncated when the runtime recorded no size at all", () => {
    const spans = fxTurnSpans(turn({ tools: [{ name: "meeting_wait", at: 5, input: {}, output: "{}" }] }));
    const span = spans.find((s) => s.name === "tool:meeting_wait")!;
    delete span.attributes["tool.output_bytes"];
    const [step] = toolSteps(spans);
    expect(step.responseTruncated).toBe(false);
    expect(step.responseBytes).toBeNull();
  });

  it("is tied to the model call that asked for it", () => {
    const steps = toolSteps(
      fxTurnSpans(
        turn({
          llms: [
            { at: 1, iteration: 1, asks: [{ id: "call_a", name: "meeting_wait" }] },
            { at: 5, iteration: 2, asks: [{ id: "call_b", name: "meeting_speak" }, { id: "call_c", name: "knowledge_search" }] },
          ],
          tools: [
            { name: "meeting_wait", at: 2, callId: "call_a" },
            { name: "meeting_speak", at: 6, callId: "call_b" },
            { name: "knowledge_search", at: 6.2, callId: "call_c" },
            { name: "meeting_leave", at: 9, callId: "call_unknown" },
          ],
        }),
      ),
    );
    expect(steps.map((s) => s.modelCall)).toEqual([1, 2, 2, null]);
    expect(steps.map((s) => s.callId)).toEqual(["call_a", "call_b", "call_c", "call_unknown"]);
  });

  it("carries what a posting call answered and created", () => {
    const posted = hex("the-posted-message");
    const [step] = toolSteps(
      fxTurnSpans(turn({ tools: [{ name: "reply", at: 20, input: { reply_to: ROOT, text: "Done." }, output: `posted (5 characters) · event_id ${posted}`, extra: { "nostr.posted_event_id": posted } }] })),
    );
    expect(step.posted).toEqual({ eventId: posted, replyTo: ROOT });
  });

  it("has no posting details when the tool does not post", () => {
    const [step] = toolSteps(fxTurnSpans(turn({ tools: [{ name: "meeting_wait", at: 2, input: {}, output: "{}" }] })));
    expect(step.posted).toBeNull();
  });
});

describe("the steps of a turn", () => {
  const STEER_ID = hex("steered-message");

  it("interleave the model's words, a steered message and tool calls by the time they started", () => {
    const { steps } = transcriptOf(
      fxTurnSpans(
        turn({
          llms: [{ at: 2, text: "Joining now." }],
          steers: [{ at: 2.5, eventId: STEER_ID, text: "Also say hi." }],
          tools: [{ name: "meeting_join", at: 3, input: { url: "https://x" }, output: { status: "joined" } }],
        }),
      ),
    ).turns[0];
    expect(steps.map((s) => [s.seq, s.type])).toEqual([
      [1, "assistant"],
      [2, "steer"],
      [3, "tool"],
    ]);
  });

  it("put the model call before a tool that started at the same instant", () => {
    const { steps } = transcriptOf(fxTurnSpans(turn({ tools: [{ name: "meeting_join", at: 5, input: {} }], llms: [{ at: 5, text: "Let me join." }] }))).turns[0];
    expect(steps.map((s) => s.type)).toEqual(["assistant", "tool"]);
  });

  it("show the words a model wrote, and no model call that only asked for tools", () => {
    const { steps } = transcriptOf(
      fxTurnSpans(turn({ llms: [{ at: 1, asks: [{ id: "c1", name: "meeting_wait" }] }, { at: 4, iteration: 2, text: "Nothing to add.", prompt: 5000 }] })),
    ).turns[0];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: "assistant", modelCall: 2, model: "deepseek-flash", text: "Nothing to add." });
  });

  it("add a step per model call when asked for the detail, with its size and what it asked for", () => {
    const { steps } = transcriptOf(
      fxTurnSpans(turn({ llms: [{ at: 1, dur: 2, iteration: 7, prompt: 16390, completion: 60, asks: [{ id: "c1", name: "meeting_speak" }, { id: "c2", name: "knowledge_search" }] }] })),
      { verbose: true },
    ).turns[0];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      type: "model",
      modelCall: 7,
      model: "deepseek-flash",
      durationMs: 2000,
      promptTokens: 16390,
      completionTokens: 60,
      cacheReadTokens: 0,
      asked: ["meeting_speak", "knowledge_search"],
    });
  });

  it("do not repeat the turn's closing text as a model step", () => {
    const closing = "I joined the huddle and posted the summary.";
    const t = transcriptOf(fxTurnSpans(turn({ output: closing, llms: [{ at: 50, text: closing }, { at: 20, iteration: 1, text: "Halfway there." }] }))).turns[0];
    expect(t.steps.map((s) => (s.type === "assistant" ? s.text : s.type))).toEqual(["Halfway there."]);
    expect(t.output?.text).toBe(closing);
  });

  it("give a steered message with its whole text, who sent it, and whether the turn received it", () => {
    const long = `${"Please also keep it to one sentence. ".repeat(10)}Thanks.`;
    const { steps } = transcriptOf(
      fxTurnSpans(
        turn({
          steers: [
            { at: 10, eventId: STEER_ID, text: long, sender: "Elio Tran" },
            { at: 50, eventId: hex("late-message"), text: "Too late.", delivered: false },
          ],
        }),
      ),
    ).turns[0];
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ type: "steer", eventId: STEER_ID, sender: "Elio Tran", text: long, delivered: null });
    expect(steps[1]).toMatchObject({ type: "steer", text: "Too late.", delivered: false });
  });
});

describe("filters on the steps", () => {
  const spans = () =>
    fxTurnSpans(
      turn({
        llms: [{ at: 1, text: "On it." }],
        tools: [
          { name: "meeting_wait", at: 2, input: {}, output: "{}" },
          { name: "meeting_speak", at: 3, input: { text: "Hi" }, output: { spoken: true } },
          { name: "knowledge_search", at: 4, input: { query: "bom" }, status: "ERROR", statusMessage: "timeout" },
          { name: "meeting_speak", at: 5, input: { text: "Bye" }, output: { spoken: true } },
        ],
      }),
    );

  it("keep the tools whose name contains any of the words, whatever their case, and nothing else", () => {
    const { steps } = transcriptOf(spans(), { tools: ["SPEAK", "wait"] }).turns[0];
    expect(steps.map((s) => (s.type === "tool" ? s.name : s.type))).toEqual(["meeting_wait", "meeting_speak", "meeting_speak"]);
  });

  it("keep the numbers the steps had in the whole turn, so a step can be named whatever the filter", () => {
    const { steps } = transcriptOf(spans(), { tools: ["knowledge"] }).turns[0];
    expect(steps.map((s) => s.seq)).toEqual([4]);
  });

  it("keep failed steps only", () => {
    const { steps } = transcriptOf(spans(), { failuresOnly: true }).turns[0];
    expect(steps.map((s) => [s.seq, s.type === "tool" ? s.name : s.type])).toEqual([[4, "knowledge_search"]]);
  });

  it("still list a turn that has no step left, so the reader knows it ran", () => {
    const t = transcriptOf(spans(), { tools: ["no_such_tool"] });
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].steps).toEqual([]);
  });
});

describe("a turn", () => {
  const content = "Hi Kent.\nPlease join the huddle https://ba.example/huddle/1";

  it("has its request: who wrote it, the message whole, and the prompt the agent was handed", () => {
    const t = transcriptOf(fxTurnSpans(turn({ content, sender: "Elio Tran" }))).turns[0];
    expect(t.request.from).toBe("Elio Tran");
    expect(t.request.message).toBe(content);
    expect(t.request.prompt?.text).toContain("[Agent Memory — core]");
    expect(t.request.prompt?.text).toContain("[Buzz event: @mention]");
    expect(t.eventId).toBe(ROOT);
  });

  it("has no message of its own when the prompt is not a Buzz envelope, and still gives the prompt", () => {
    const spans = fxTurnSpans(turn());
    spans.find((s) => s.name === "agent_turn")!.attributes["input.value"] = "just a plain prompt";
    const t = transcriptOf(spans).turns[0];
    expect(t.request.message).toBeNull();
    expect(t.request.prompt?.text).toBe("just a plain prompt");
  });

  it("has the agent, the times and the closing text its agent_turn span gives", () => {
    const t = transcriptOf(fxTurnSpans(turn({ start: 10, end: 70, output: "All done.", agent: "kent-twin" }))).turns[0];
    expect(t).toMatchObject({ agent: "kent-twin", rootRecorded: true, status: "OK", durationMs: 60000 });
    expect(t.startTime?.toISOString()).toBe("2026-11-08T04:46:22.000Z");
    expect(t.endTime?.toISOString()).toBe("2026-11-08T04:47:22.000Z");
    expect(t.output?.text).toBe("All done.");
  });

  it("does not invent an agent, an end or a closing text for a trace whose agent_turn span was never exported", () => {
    const t = transcriptOf(fxTurnSpans(turn({ rootless: true, llms: [{ at: 2, dur: 1, text: "Hello" }], tools: [{ name: "meeting_join", at: 3, dur: 0.5, input: {}, output: "{}" }] }))).turns[0];
    expect(t.rootRecorded).toBe(false);
    expect(t.agent).toBeNull();
    expect(t.output).toBeNull();
    // the window is that of the spans seen: from the model call at 2 s to the end of the tool at 3.5 s
    expect(t.startTime?.toISOString()).toBe("2026-11-08T04:46:14.000Z");
    expect(t.endTime?.toISOString()).toBe("2026-11-08T04:46:15.500Z");
    expect(t.durationMs).toBe(1500);
    // the prompt is still there: the model calls carry it
    expect(t.request.prompt?.text).toContain("Event ID:");
    expect(t.request.from).toBe("Elio Tran");
    expect(t.steps.map((s) => s.type)).toEqual(["assistant", "tool"]);
  });
});
