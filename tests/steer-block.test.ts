/**
 * What the Buzz fork really writes for a steered message, seen on live ba threads: the span's `input.value` is the whole block
 * the agent was handed (a framing line, the envelope, a closing note), `nostr.sender_name` is absent (the block's From line
 * has an npub and no name), and `steer.delivered`, `steer.end_reason` and `steer.uuid` say whether and how it arrived.
 */
import { describe, expect, it } from "vitest";
import { STEER_BLOCK_HEADER, STEER_CAPPED_EVENT_NAME, STEER_DELIVERED_ATTR, STEER_END_REASON_ATTR, STEER_SENDER_PUBKEY_ATTR, STEER_UUID_ATTR } from "../src/contract.js";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { ThreadQueryEngine } from "../src/engine/query.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { MarkdownRenderer } from "../src/formatters/markdown.js";
import { TerminalRenderer } from "../src/formatters/terminal.js";
import { hex, HUMAN, steerBlock, turnSpans } from "./helpers/phoenix-thread.js";

const ROOT = hex("block-root");
const OPENING = ROOT;
const aggregate = (spans: ReturnType<typeof turnSpans>) => new ThreadAggregator(ROOT, "ba").aggregate(spans);
const terminal = (t: ReturnType<typeof aggregate>) => new TerminalRenderer(false).render(t);
const short = (id: string) => `${id.slice(0, 8)}…`;

const live = (extra: Partial<Parameters<typeof turnSpans>[0]> = {}) =>
  turnSpans({
    trace: "t1",
    agent: "ba-paul-twin",
    event: OPENING,
    root: ROOT,
    start: 0,
    end: 16,
    steers: [
      { eventId: hex("m1"), text: steerBlock({ eventId: hex("m1"), root: ROOT, content: "@Paul Twin Separate question: which SAP table holds material descriptions?" }), at: 3, priority: "now", delivered: true, endReason: "echo", senderPubkey: HUMAN },
      { eventId: hex("m2"), text: steerBlock({ eventId: hex("m2"), root: ROOT, content: "@Paul Twin And what is MARA-MTART?" }), at: 6, priority: "now", delivered: true, endReason: "result", senderPubkey: HUMAN },
    ],
    ...extra,
  });

describe("the contract names the fork adds", () => {
  it("are constants of the contract module", () => {
    expect(STEER_DELIVERED_ATTR).toBe("steer.delivered");
    expect(STEER_END_REASON_ATTR).toBe("steer.end_reason");
    expect(STEER_UUID_ATTR).toBe("steer.uuid");
    expect(STEER_SENDER_PUBKEY_ATTR).toBe("nostr.sender_pubkey");
    expect(STEER_CAPPED_EVENT_NAME).toBe("steer_spans_capped");
    expect(STEER_BLOCK_HEADER).toBe("[New message — arrived while you were working]");
  });
});

describe("the text of a steered message", () => {
  it("is the block's Content line, not the framing header, the envelope or the closing note", () => {
    const [first, second] = aggregate(live()).turns[0].steered!;
    expect(first.text).toBe("@Paul Twin Separate question: which SAP table holds material descriptions?");
    expect(second.text).toBe("@Paul Twin And what is MARA-MTART?");
    for (const m of [first, second]) {
      expect(m.text).not.toMatch(/New message|Buzz event|Note:|Tags:|Parsed:/);
    }
  });

  it("shows in the report as the question, not as the framing", () => {
    const out = terminal(aggregate(live()));
    expect(out).toContain(`↳ steered ${short(hex("m1"))} (now) "@Paul Twin Separate question: which SAP table holds material descriptions?"`);
    expect(out).not.toContain("arrived while you were working");
    const compact = JSON.parse(new JsonRenderer().render(aggregate(live()), { compact: true, flat: true }));
    expect(compact.turns[0].steered[0].text).toBe("@Paul Twin Separate question: which SAP table holds material descriptions?");
  });

  it("is a content with several lines, whole, up to the next field of the envelope", () => {
    const block = steerBlock({ eventId: hex("m1"), root: ROOT, content: "first line\nsecond line" });
    const t = aggregate(live({ steers: [{ eventId: hex("m1"), text: block, at: 3 }] }));
    expect(t.turns[0].steered![0].text).toBe("first line\nsecond line");
  });

  it("is the whole text when a runtime records only the message, minus the framing line when it is there", () => {
    const plain = aggregate(live({ steers: [{ eventId: hex("m1"), text: "just the words", at: 3 }] })).turns[0].steered![0];
    expect(plain.text).toBe("just the words");
    const framed = aggregate(live({ steers: [{ eventId: hex("m1"), text: `${STEER_BLOCK_HEADER}\n\nthe words after the header`, at: 3 }] })).turns[0].steered![0];
    expect(framed.text).toBe("the words after the header");
  });
});

describe("the id and the sender of a steered message", () => {
  it("come from the block when the span has no nostr.event_id", () => {
    const t = aggregate(live({ steers: [{ eventId: hex("m1"), noEventId: true, text: steerBlock({ eventId: hex("m1"), root: ROOT, content: "x" }), at: 3 }] }));
    expect(t.turns[0].steered![0].eventId).toBe(hex("m1"));
    expect(t.turns[0].steeredEventIds).toEqual([hex("m1")]);
  });

  it("show no name when the block has an npub and no name, and keep the sender's pubkey", () => {
    const m = aggregate(live()).turns[0].steered![0];
    expect(m.sender).toBeNull();
    expect(m.senderPubkey).toBe(HUMAN);
    expect(aggregate(live()).toJSON().turns[0].steered![0]).toMatchObject({ sender: null, sender_pubkey: HUMAN });
  });

  it("show the name the span records, else a real name in the block", () => {
    const named = aggregate(live({ steers: [{ eventId: hex("m1"), text: "x", at: 3, sender: "Elio Tran" }] })).turns[0].steered![0];
    expect(named.sender).toBe("Elio Tran");
    const fromBlock = aggregate(live({ steers: [{ eventId: hex("m1"), at: 3, text: steerBlock({ eventId: hex("m1"), root: ROOT, content: "x", from: "Elio Tran" }) }] })).turns[0].steered![0];
    expect(fromBlock.sender).toBe("Elio Tran");
  });
});

describe("a steered message that was not delivered", () => {
  const undelivered = (delivered: boolean | string) =>
    live({
      steers: [
        { eventId: hex("m1"), text: steerBlock({ eventId: hex("m1"), root: ROOT, content: "delivered one" }), at: 3, priority: "now", delivered: true, endReason: "echo" },
        { eventId: hex("m2"), text: steerBlock({ eventId: hex("m2"), root: ROOT, content: "arrived too late" }), at: 14, priority: "now", delivered, endReason: "turn_end" },
      ],
    });

  for (const delivered of [false, "false"]) {
    it(`(steer.delivered ${JSON.stringify(delivered)}) is listed, but not counted as handled`, () => {
      const turn = aggregate(undelivered(delivered)).turns[0];
      expect(turn.steered?.map((m) => [m.eventId, m.delivered, m.endReason])).toEqual([
        [hex("m1"), true, "echo"],
        [hex("m2"), false, "turn_end"],
      ]);
      expect(turn.handledMessages).toBe(2);
      expect(turn.steeredEventIds).toEqual([hex("m1")]);
    });
  }

  it("is said so in the report, with no promise that anything handled it", () => {
    const out = terminal(aggregate(undelivered(false)));
    expect(out).toContain("Handled  : 2 messages (1 steered)");
    expect(out).toContain(`↳ steered ${short(hex("m1"))} (now) "delivered one"`);
    expect(out).toContain(`↳ not delivered ${short(hex("m2"))} (now) "arrived too late" — the turn ended before it reached it`);
    const md = new MarkdownRenderer().render(aggregate(undelivered(false)));
    expect(md).toContain("| 2 (1 steered) |");
    expect(md).toContain(`\`${short(hex("m2"))}\` (now) was sent to Turn 1 · ba-paul-twin, but the turn ended before it reached it: arrived too late`);
  });

  it("is in the compact JSON apart from the handled ones, and in the full JSON with its delivery", () => {
    const t = aggregate(undelivered(false));
    const compact = JSON.parse(new JsonRenderer().render(t, { compact: true, flat: true })).turns[0];
    expect(compact.msgs).toBe(2);
    expect(compact.steered).toEqual([{ id: hex("m1").slice(0, 8), text: "delivered one" }]);
    expect(compact.not_delivered).toEqual([{ id: hex("m2").slice(0, 8), text: "arrived too late" }]);
    const full = t.toJSON().turns[0];
    expect(full.steered![1]).toMatchObject({ event_id: hex("m2"), delivered: false, end_reason: "turn_end" });
    expect(full.steered_event_ids).toEqual([hex("m1")]);
    expect(full.handled_messages).toBe(2);
  });

  it("is not a message a later reply is linked to the turn through, and not looked for among the turns' own posts", () => {
    const spans = [
      ...undelivered(false).filter((s) => s.name !== "tool:mcp__buzz-thread__reply"),
      ...turnSpans({ trace: "t0", agent: "ba-kent-twin", event: hex("k0"), root: ROOT, start: -30, end: -20, posts: [{ replyTo: hex("k0"), text: "an earlier answer", at: -25 }] }),
      ...turnSpans({ trace: "t2", agent: "ba-paul-twin", event: hex("later"), replyTo: hex("m2"), root: ROOT, start: 40, end: 48 }),
    ];
    const t = aggregate(spans);
    const later = t.turns.find((x) => x.traceId === "t2")!;
    expect(later.parentEdgeType).not.toBe("REPLY_TO");
    expect(later.parentEdgeType).not.toBe("INFERRED");
    expect(later.parentMessage?.basis).not.toBe("steered");
    expect(later.parentMessage?.postedByTurn).toBeNull();
  });

  it("is linked to the turn it started, when it did start one", () => {
    const spans = [...undelivered(false), ...turnSpans({ trace: "t2", agent: "ba-paul-twin", event: hex("m2"), replyTo: ROOT, root: ROOT, start: 30, end: 40 }), ...turnSpans({ trace: "t3", agent: "ba-paul-twin", event: hex("e3"), replyTo: hex("m2"), root: ROOT, start: 50, end: 58 })];
    const t = aggregate(spans);
    const third = t.turns.find((x) => x.traceId === "t3")!;
    expect(third.parentMessage?.basis).toBe("started");
    expect(third.parentTurnIndex).toBe(t.turns.find((x) => x.traceId === "t2")!.turnIndex);
  });
});

describe("steer spans cut off by the runtime", () => {
  it("say so in every report: the list of steered messages is not complete", () => {
    const t = aggregate(live({ steerCapped: true }));
    expect(t.turns[0].steerCapped).toBe(true);
    expect(terminal(t)).toContain("↳ more messages were steered into this turn than the runtime records: this list is not complete");
    expect(new MarkdownRenderer().render(t)).toContain("more messages were steered into this turn than the runtime records");
    expect(t.toJSON().turns[0].steered_capped).toBe(true);
    expect(JSON.parse(new JsonRenderer().render(t, { compact: true, flat: true })).turns[0].steered_capped).toBe(true);
  });

  it("say nothing for a turn that was not cut off", () => {
    const t = aggregate(live());
    expect(t.turns[0].steerCapped).toBe(false);
    expect(terminal(t)).not.toContain("this list is not complete");
    expect(t.toJSON().turns[0].steered_capped).toBeUndefined();
  });
});

describe("whether a steered message would show in the trace", () => {
  const plain = (trace: string, agent: string, start: number, extra: Partial<Parameters<typeof turnSpans>[0]> = {}) =>
    turnSpans({ trace, agent, event: hex(`e-${trace}`), root: ROOT, start, end: start + 8, ...extra });

  it("is not said to be missing for a turn whose runtime records the ids it posted: nothing was steered", () => {
    const t = aggregate(plain("t1", "ba-paul-twin", 0, { posts: [{ replyTo: hex("e-t1"), text: "an answer", at: 4, eventId: hex("answer") }] }));
    const out = terminal(t);
    expect(out).toContain("Handled  : 1 message");
    expect(out).not.toContain("steered messages are not recorded");
    expect(t.turns[0].steeringRecorded).toBe(true);
    expect(t.steeringRecorded).toBe(true);
    expect(t.toJSON().steering).toBe("recorded");
    expect(JSON.parse(new JsonRenderer().render(t, { compact: true, flat: true })).steering).toBeUndefined();
  });

  it("is not said to be missing for a turn of an agent that shows it elsewhere in the thread, and is for one that does not", () => {
    const t = aggregate([
      ...plain("t1", "ba-paul-twin", 0, { posts: [{ replyTo: hex("e-t1"), text: "an answer", at: 4, eventId: hex("answer") }] }),
      ...plain("t2", "ba-paul-twin", 20, { posts: [{ replyTo: hex("e-t2"), text: "an answer without a recorded id", at: 24 }] }),
      ...plain("t3", "ba-kent-twin", 40, { posts: [{ replyTo: hex("e-t3"), text: "an older runtime's answer", at: 44 }] }),
    ]);
    const by = (trace: string) => t.turns.find((x) => x.traceId === trace)!;
    expect(by("t1").steeringRecorded).toBe(true);
    expect(by("t2").steeringRecorded).toBe(true);
    expect(by("t3").steeringRecorded).toBe(false);
    const lines = terminal(t).split("\n").filter((l) => l.includes("Handled  :"));
    expect(lines.filter((l) => l.includes("steered messages are not recorded"))).toHaveLength(1);
    expect(new MarkdownRenderer().render(t)).toContain("Steered messages are not recorded in this trace for ba-kent-twin:");
  });

  it("is true for a turn with a steer record, wherever the record sits, and a cut-off turn", () => {
    expect(aggregate(live()).turns[0].steeringRecorded).toBe(true);
    expect(aggregate(live({ steers: [] , steerCapped: true })).turns[0].steeringRecorded).toBe(true);
  });

  it("is still said to be missing for a trace written before the contract", () => {
    const t = aggregate(plain("t1", "ba-paul-twin", 0, { posts: [{ replyTo: hex("e-t1"), text: "an answer", at: 4 }] }));
    expect(terminal(t)).toContain("Handled  : 1 message — steered messages are not recorded in this trace");
    expect(t.turns[0].steeringRecorded).toBe(false);
    expect(t.toJSON().steering).toBe("not_recorded");
  });

  it("is kept when a query keeps only some of the turns", () => {
    const t = aggregate([
      ...plain("t1", "ba-paul-twin", 0, { posts: [{ replyTo: hex("e-t1"), text: "an answer", at: 4, eventId: hex("answer") }] }),
      ...plain("t2", "ba-paul-twin", 20),
    ]);
    const last = new ThreadQueryEngine().filter(t, { lastN: 1 });
    expect(last.steeringRecorded).toBe(true);
    expect(JSON.parse(new JsonRenderer().render(last, { compact: true, flat: true })).steering).toBeUndefined();
    const old = aggregate(plain("t1", "ba-paul-twin", 0));
    expect(JSON.parse(new JsonRenderer().render(new ThreadQueryEngine().filter(old, { lastN: 1 }), { compact: true, flat: true })).steering).toBe("not_recorded");
  });
});

describe("a turn as the fork records it when steers interrupt a reply (seen live)", () => {
  // Three steers while the turn ran: the first reply call was moved to the background (no id), the second was interrupted
  // (an error), the third posted and recorded its id.
  const spans = turnSpans({
    trace: "t1",
    agent: "ba-paul-twin",
    event: OPENING,
    root: ROOT,
    start: 0,
    end: 16,
    steers: ["m1", "m2", "m3"].map((m, i) => ({
      eventId: hex(m),
      text: steerBlock({ eventId: hex(m), root: ROOT, content: `question ${i + 2}` }),
      at: 2 + i * 3,
      priority: "now",
      delivered: true,
      endReason: i === 0 ? "result" : "echo",
      senderPubkey: HUMAN,
    })),
    posts: [
      { replyTo: OPENING, text: "1) first answer", at: 5, dur: 0.3 },
      { replyTo: hex("m2"), text: "3) third answer", at: 8, dur: 0.8, error: true },
      { replyTo: hex("m3"), text: "3) third answer", at: 12, dur: 1.3, eventId: hex("third-post") },
    ],
  });

  it("reads three steered messages, the posts it can place, and no 'not recorded' statement", () => {
    const out = terminal(aggregate(spans));
    expect(out).toContain("Handled  : 4 messages (3 steered)");
    expect(out).toContain(`"question 2"`);
    expect(out).toContain(`"question 4"`);
    expect(out).toContain('Posted   : id not recorded  "1) first answer"');
    expect(out).toContain(`Posted   : ${short(hex("third-post"))}  "3) third answer"`);
    expect(out).not.toContain("steered messages are not recorded");
    expect(out).not.toContain("arrived while you were working");
  });
});
