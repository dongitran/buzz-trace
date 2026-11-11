/**
 * The dialogue: who said what, in order. In a huddle the meeting gate hands the agent what people said as the output of
 * `meeting_wait` (`heard[]`) and takes what the agent says as the input of `meeting_speak`, answering whether it was spoken to the
 * end or cut off. In a plain thread the dialogue is the message that started each turn, the messages steered into it and what the
 * agent posted. Nothing here is inferred: a line is there because a span recorded it.
 */
import { describe, expect, it } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { extractDialogue } from "../src/engine/dialogue.js";
import { TranscriptBuilder } from "../src/engine/transcript.js";
import type { SpanNode } from "../src/models.js";
import { hex } from "./helpers/phoenix-thread.js";
import { fxTurnSpans, type FxTool, type FxTurn } from "./helpers/transcript-fixture.js";

const ROOT = hex("dialogue-root");

const turn = (over: Partial<FxTurn> = {}): FxTurn => ({ trace: "tr1", root: ROOT, event: ROOT, start: 0, end: 120, content: "@Kent Twin join the huddle https://ba.example/huddle/1", ...over });

function dialogueOf(spans: SpanNode[]) {
  const telemetry = new ThreadAggregator(ROOT, "ba").aggregate(spans);
  return extractDialogue(new TranscriptBuilder().build(telemetry));
}

/** What `meeting_wait` returns when people spoke (shape read from a live gate). */
const heard = (...lines: Array<{ at: string; speaker: string; text: string; reason?: string }>) => ({
  state: "in_meeting",
  event: "addressed",
  meeting_id: "94f4e195e210",
  addressed: lines.map((l) => ({ reason: "one_on_one", ...l })),
  heard: lines.map((l) => ({ reason: "one_on_one", ...l })),
  heard_omitted: 0,
  context: [],
  one_on_one: true,
});

const wait = (at: number, output: unknown, dur = 3): FxTool => ({ name: "meeting_wait", at, dur, input: { timeout_seconds: 40, context_seconds: 0 }, output });
const speak = (at: number, text: string, result: unknown, dur = 2): FxTool => ({ name: "meeting_speak", at, dur, input: { text }, output: result });
const join = (at: number, displayName = "Kent Twin"): FxTool => ({ name: "meeting_join", at, dur: 1, input: { url: "https://ba.example/huddle/1", display_name: displayName }, output: { status: "joined" } });

describe("the dialogue of a thread", () => {
  it("starts with the message that started the turn, from whoever wrote it", () => {
    const [first] = dialogueOf(fxTurnSpans(turn({ sender: "Elio Tran" })));
    expect(first).toMatchObject({
      turn: 1,
      direction: "in",
      channel: "thread",
      via: "message",
      speaker: "Elio Tran",
      text: "@Kent Twin join the huddle https://ba.example/huddle/1",
      eventId: ROOT,
    });
    expect(first.at?.toISOString()).toBe("2026-11-08T04:46:12.000Z");
  });

  it("puts a steered message in at the time it arrived, with its whole text", () => {
    const text = `${"Keep it short. ".repeat(12)}Thanks.`;
    const lines = dialogueOf(fxTurnSpans(turn({ steers: [{ at: 30, eventId: hex("steer-1"), text, sender: "Elio Tran" }] })));
    expect(lines.map((l) => l.via)).toEqual(["message", "steer"]);
    expect(lines[1]).toMatchObject({ direction: "in", channel: "thread", speaker: "Elio Tran", text, eventId: hex("steer-1") });
  });

  it("gives what the agent posted to the thread, under the agent's name", () => {
    const posted = hex("posted-message");
    const lines = dialogueOf(
      fxTurnSpans(turn({ tools: [{ name: "reply", at: 90, input: { reply_to: ROOT, text: "Huddle summary.\n\n1. BOM" }, output: `posted · event_id ${posted}`, extra: { "nostr.posted_event_id": posted } }] })),
    );
    expect(lines[1]).toMatchObject({ direction: "out", channel: "thread", via: "reply", speaker: "kent-twin", text: "Huddle summary.\n\n1. BOM", eventId: posted });
  });
});

describe("the dialogue of a huddle", () => {
  it("gives each thing people said, with the call offset, why it reached the agent, and when the agent got it", () => {
    const lines = dialogueOf(
      fxTurnSpans(
        turn({
          tools: [
            join(1),
            wait(2, heard({ at: "00:11", speaker: "Elio Tran", text: "Hi. Kent.", reason: "mention" })),
            wait(8, heard({ at: "00:24", speaker: "Elio Tran", text: "Ready. Can you explain a phantom assembly?" }, { at: "00:30", speaker: "Sam Wu", text: "Same question here." })),
          ],
        }),
      ),
    ).filter((l) => l.channel === "meeting");

    expect(lines.map((l) => [l.direction, l.speaker, l.text, l.offset, l.reason, l.via])).toEqual([
      ["in", "Elio Tran", "Hi. Kent.", "00:11", "mention", "meeting_wait"],
      ["in", "Elio Tran", "Ready. Can you explain a phantom assembly?", "00:24", "one_on_one", "meeting_wait"],
      ["in", "Sam Wu", "Same question here.", "00:30", "one_on_one", "meeting_wait"],
    ]);
    // the agent got the first one when its wait returned: it started at 2 s and took 3 s
    expect(lines[0].at?.toISOString()).toBe("2026-11-08T04:46:17.000Z");
  });

  it("lists nothing for a wait in which nobody spoke, nor for a line that holds no words", () => {
    const lines = dialogueOf(
      fxTurnSpans(
        turn({
          tools: [
            wait(2, { state: "in_meeting", event: "timeout", addressed: [], heard: [], heard_omitted: 0 }),
            wait(8, { state: "in_meeting", event: "addressed", heard: [{ at: "00:40", speaker: "Elio Tran", text: "  " }], addressed: [] }),
          ],
        }),
      ),
    );
    expect(lines.filter((l) => l.channel === "meeting")).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("lists an utterance once when the gate gives it as both heard and addressed, and keeps one that is only addressed", () => {
    const both = { at: "00:11", speaker: "Elio Tran", text: "Hi. Kent.", reason: "mention" };
    const onlyAddressed = { at: "00:15", speaker: "Elio Tran", text: "Are you there?", reason: "mention" };
    const lines = dialogueOf(
      fxTurnSpans(turn({ tools: [wait(2, { event: "addressed", heard: [both], addressed: [both, onlyAddressed] })] })),
    ).filter((l) => l.channel === "meeting");
    expect(lines.map((l) => l.text)).toEqual(["Hi. Kent.", "Are you there?"]);
  });

  it("gives what the agent said under the name it joined with, whole, and that it was spoken to the end", () => {
    const text = `${"A phantom is a structural grouping you never stock. ".repeat(8)}That is all.`;
    const lines = dialogueOf(fxTurnSpans(turn({ tools: [join(1, "Kent Twin"), speak(5, text, { spoken: true, result: "Finished speaking." })] })));
    const said = lines.find((l) => l.via === "meeting_speak")!;
    expect(said).toMatchObject({ direction: "out", channel: "meeting", speaker: "Kent Twin", text, outcome: "complete", result: "Finished speaking.", interruptedBy: null, spoken: null });
    expect(said.at?.toISOString()).toBe("2026-11-08T04:46:17.000Z");
  });

  it("says when the agent was cut off, by whom, and how much of it was spoken", () => {
    const lines = dialogueOf(
      fxTurnSpans(
        turn({ tools: [join(1), speak(5, "Hi Elio, this is Kent Twin. I'm listening.", { spoken: true, result: 'Interrupted by Elio Tran. Spoken until now: "Hi Elio"' })] }),
      ),
    );
    const said = lines.find((l) => l.via === "meeting_speak")!;
    expect(said).toMatchObject({
      outcome: "interrupted",
      interruptedBy: "Elio Tran",
      spoken: "Hi Elio",
      text: "Hi Elio, this is Kent Twin. I'm listening.",
    });
  });

  it("reads a cut-off whose spoken part itself holds quotes", () => {
    const lines = dialogueOf(
      fxTurnSpans(turn({ tools: [join(1), speak(5, 'He said "stop" twice.', { spoken: true, result: 'Interrupted by Elio Tran. Spoken until now: "He said "stop""' })] })),
    );
    expect(lines.find((l) => l.via === "meeting_speak")).toMatchObject({ outcome: "interrupted", interruptedBy: "Elio Tran", spoken: 'He said "stop"' });
  });

  it("says when the agent was told it did not speak at all", () => {
    const result = "Not spoken: you were interrupted. Call meeting_wait now and listen; speak again after it returns.";
    const said = dialogueOf(fxTurnSpans(turn({ tools: [join(1), speak(5, "Let me answer that.", { spoken: false, result })] }))).find((l) => l.via === "meeting_speak")!;
    expect(said).toMatchObject({ outcome: "not_spoken", result });
  });

  it("says when speech was sent off without waiting for it to end", () => {
    const said = dialogueOf(fxTurnSpans(turn({ tools: [join(1), speak(5, "Let me check our docs...", { spoken: true, result: "Speaking dispatched asynchronously (non-blocking)." }, 0)] }))).find((l) => l.via === "meeting_speak")!;
    expect(said.outcome).toBe("async");
  });

  it("keeps a result it does not recognise as it is", () => {
    const said = dialogueOf(fxTurnSpans(turn({ tools: [join(1), speak(5, "Hello", { spoken: true, result: "Queued behind another utterance." })] }))).find((l) => l.via === "meeting_speak")!;
    expect(said).toMatchObject({ outcome: "unknown", result: "Queued behind another utterance." });
  });

  it("keeps the name the agent joined with for a later turn that does not join again, and falls back to the agent's name, then to 'agent'", () => {
    const second = fxTurnSpans(turn({ trace: "tr2", event: hex("second"), start: 200, end: 260, tools: [speak(210, "Back again.", { spoken: true, result: "Finished speaking." })] }));
    const first = fxTurnSpans(turn({ tools: [join(1, "Kent Twin")] }));
    const lines = dialogueOf([...first, ...second]).filter((l) => l.via === "meeting_speak");
    expect(lines.map((l) => l.speaker)).toEqual(["Kent Twin"]);

    const unnamed = dialogueOf(fxTurnSpans(turn({ tools: [speak(5, "No join here.", { spoken: true, result: "Finished speaking." })] }))).find((l) => l.via === "meeting_speak")!;
    expect(unnamed.speaker).toBe("kent-twin");

    const rootless = dialogueOf(fxTurnSpans(turn({ rootless: true, tools: [speak(5, "No root, no join.", { spoken: true, result: "Finished speaking." })] }))).find((l) => l.via === "meeting_speak")!;
    expect(rootless.speaker).toBe("agent");
  });

  it("leaves out what a failed call would have said: it was not said", () => {
    const failed: FxTool = { ...speak(8, "Second.", { spoken: false }), status: "ERROR", statusMessage: "gate closed" };
    const lines = dialogueOf(fxTurnSpans(turn({ tools: [join(1), speak(5, "First.", { spoken: true, result: "Finished speaking." }), failed, speak(12, "Third.", { spoken: true, result: "Finished speaking." })] })));
    expect(lines.filter((l) => l.via === "meeting_speak").map((l) => l.text)).toEqual(["First.", "Third."]);
  });

  it("leaves out a steered message the turn ended before receiving, and keeps the one it received", () => {
    const lines = dialogueOf(
      fxTurnSpans(
        turn({
          steers: [
            { at: 30, eventId: hex("received"), text: "Received in time.", sender: "Elio Tran" },
            { at: 100, eventId: hex("too-late"), text: "Sent too late.", sender: "Elio Tran", delivered: false },
          ],
        }),
      ),
    );
    expect(lines.filter((l) => l.via === "steer").map((l) => l.text)).toEqual(["Received in time."]);
  });

  it("follows the order the steps ran in, turn after turn", () => {
    const lines = dialogueOf([
      ...fxTurnSpans(turn({ tools: [join(1), wait(2, heard({ at: "00:05", speaker: "Elio Tran", text: "First question?" })), speak(6, "First answer.", { spoken: true, result: "Finished speaking." })] })),
      ...fxTurnSpans(turn({ trace: "tr2", event: hex("second"), start: 200, end: 260, content: "@Kent Twin rejoin", tools: [wait(205, heard({ at: "05:00", speaker: "Elio Tran", text: "Second question?" }))] })),
    ]);
    expect(lines.map((l) => `${l.turn}:${l.via}:${l.text}`)).toEqual([
      "1:message:@Kent Twin join the huddle https://ba.example/huddle/1",
      "1:meeting_wait:First question?",
      "1:meeting_speak:First answer.",
      "2:message:@Kent Twin rejoin",
      "2:meeting_wait:Second question?",
    ]);
  });
});
