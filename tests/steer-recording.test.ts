/**
 * With `turn_handling: steer`, a message that arrives while an agent's turn is running is injected into that turn and starts
 * no trace of its own. The fork records only the opening message, so Phoenix shows one message for four. The contract that
 * makes steered messages visible: a child span named `steer` under the turn's `agent_turn` span (or a span event of the same
 * name) with `nostr.event_id`, `input.value`, `nostr.sender_name` and `steer.priority`. Without it, buzz-trace only knows of a
 * steered message when a reply call answered it, and says that nothing else is recorded.
 */
import { describe, expect, it } from "vitest";
import {
  STEER_EVENT_NAME,
  STEER_EVENT_ID_ATTR,
  STEER_PRIORITY_ATTR,
  STEER_SENDER_ATTR,
  STEER_SPAN_KIND,
  STEER_SPAN_NAME,
  STEER_TEXT_ATTR,
} from "../src/contract.js";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { hex, T0, turnSpans } from "./helpers/phoenix-thread.js";

const ROOT = hex("steer-root");
const aggregate = (spans: ReturnType<typeof turnSpans>) => new ThreadAggregator(ROOT, "ba").aggregate(spans);
const first = (t: ReturnType<typeof aggregate>) => t.turns[0];

const steers = (as: "span" | "event") => [
  { eventId: hex("s1"), text: "One more thing for the same email: mention the SAP client number.", at: 6, sender: "Elio Tran", priority: "now", as },
  { eventId: hex("s2"), text: "And please say who on our side will send the data model.", at: 11, sender: "Elio Tran", priority: "later", as },
  { eventId: hex("s3"), text: "Keep it under 100 words.", at: 12.5, as },
];

describe("the contract names", () => {
  it("are constants of one module", () => {
    expect(STEER_SPAN_NAME).toBe("steer");
    expect(STEER_EVENT_NAME).toBe("steer");
    expect(STEER_SPAN_KIND).toBe("CHAIN");
    expect(STEER_EVENT_ID_ATTR).toBe("nostr.event_id");
    expect(STEER_TEXT_ATTR).toBe("input.value");
    expect(STEER_SENDER_ATTR).toBe("nostr.sender_name");
    expect(STEER_PRIORITY_ATTR).toBe("steer.priority");
  });
});

describe("steered messages recorded by the producer", () => {
  for (const as of ["span", "event"] as const) {
    it(`reads each message from a ${as === "span" ? "child span" : "span event"} named steer: id, text, sender, priority, time`, () => {
      const turn = first(aggregate(turnSpans({ trace: "t1", agent: "ba-paul-twin", event: hex("opening"), root: ROOT, start: 0, end: 20, steers: steers(as) })));
      expect(turn.steered?.map((s) => s.eventId)).toEqual([hex("s1"), hex("s2"), hex("s3")]);
      expect(turn.steered?.[0]).toMatchObject({
        text: "One more thing for the same email: mention the SAP client number.",
        sender: "Elio Tran",
        priority: "now",
        source: as,
      });
      expect(turn.steered?.[0].at).toBe(T0 + 6000);
      expect(turn.steered?.[1].priority).toBe("later");
      expect(turn.steered?.[2].sender).toBeNull();
      expect(turn.steeredEventIds).toEqual([hex("s1"), hex("s2"), hex("s3")]);
      expect(turn.handledMessages).toBe(4);
    });
  }

  it("takes no other span event for a steered message", () => {
    const spans = turnSpans({ trace: "t1", agent: "paul", event: hex("opening"), root: ROOT, start: 0, end: 20 });
    spans[0].events.push({ name: "exception", time: new Date(), attributes: { "nostr.event_id": hex("s1"), "input.value": "not a steer" } });
    const t = aggregate(spans);
    expect(first(t).steered).toEqual([]);
    expect(t.steeringRecorded).toBe(false);
  });

  it("lists them in the order they arrived, whatever order the spans came in", () => {
    const spans = turnSpans({ trace: "t1", agent: "paul", event: hex("opening"), root: ROOT, start: 0, end: 20, steers: steers("span") });
    const reversed = [spans[0], ...spans.slice(1).reverse()];
    expect(first(aggregate(reversed)).steered?.map((s) => s.eventId)).toEqual([hex("s1"), hex("s2"), hex("s3")]);
  });

  it("counts one message once when it is recorded as a span and as an event", () => {
    const spans = turnSpans({
      trace: "t1",
      agent: "paul",
      event: hex("opening"),
      root: ROOT,
      start: 0,
      end: 20,
      steers: [
        { eventId: hex("s1"), text: "as a span", at: 6, as: "span" },
        { eventId: hex("s1"), text: "as an event", at: 6, as: "event" },
      ],
    });
    const turn = first(aggregate(spans));
    expect(turn.steered).toHaveLength(1);
    expect(turn.steered?.[0]).toMatchObject({ source: "span", text: "as a span" });
  });

  it("keeps a steer record that names no message: the turn still handled one more", () => {
    const spans = turnSpans({ trace: "t1", agent: "paul", event: hex("opening"), root: ROOT, start: 0, end: 20 });
    spans.push(
      ...turnSpans({ trace: "t1", agent: "paul", event: hex("opening"), root: ROOT, start: 0, end: 20, steers: [{ eventId: "", text: "no id recorded", at: 5 }] }).filter((s) => s.name === "steer"),
    );
    const turn = first(aggregate(spans));
    expect(turn.handledMessages).toBe(2);
    expect(turn.steered?.[0]).toMatchObject({ eventId: null, text: "no id recorded" });
    expect(turn.steeredEventIds).toEqual([]);
  });

  it("does not count the opening message again", () => {
    const opening = hex("opening");
    const turn = first(aggregate(turnSpans({ trace: "t1", agent: "paul", event: opening, root: ROOT, start: 0, end: 20, steers: [{ eventId: opening, text: "same as the opening", at: 1 }] })));
    expect(turn.steered).toEqual([]);
    expect(turn.handledMessages).toBe(1);
  });

  it("is not a tool, a model call or a prompt: tokens, tools and previews stay as they were", () => {
    const plain = first(aggregate(turnSpans({ trace: "t1", agent: "paul", event: hex("opening"), root: ROOT, start: 0, end: 20, posts: [{ replyTo: hex("opening"), text: "an answer", at: 15 }] })));
    const steered = first(
      aggregate(
        turnSpans({ trace: "t1", agent: "paul", event: hex("opening"), root: ROOT, start: 0, end: 20, posts: [{ replyTo: hex("opening"), text: "an answer", at: 15 }], steers: steers("span") }),
      ),
    );
    expect(steered.tools.map((t) => t.name)).toEqual(plain.tools.map((t) => t.name));
    expect(steered.modelCalls).toBe(plain.modelCalls);
    expect(steered.totalTokens).toBe(plain.totalTokens);
    expect(steered.promptPreview).toBe(plain.promptPreview);
    expect(steered.responsePreview).toBe(plain.responsePreview);
    expect(steered.spans.some((s) => s.name === "steer")).toBe(true);
  });

  it("makes a later reply to a steered message an exact child of the turn that took it", () => {
    const spans = [
      ...turnSpans({ trace: "t1", agent: "paul", event: hex("opening"), root: ROOT, start: 0, end: 20, steers: steers("span") }),
      ...turnSpans({ trace: "t2", agent: "paul", event: hex("later"), replyTo: hex("s2"), root: ROOT, start: 40, end: 48 }),
    ];
    const t = aggregate(spans);
    const second = t.turns.find((x) => x.traceId === "t2")!;
    expect(second.parentTurnIndex).toBe(1);
    expect(second.parentEdgeType).toBe("REPLY_TO");
    expect(second.parentMessage).toEqual({ id: hex("s2"), basis: "steered", postedByTurn: null, turns: [1] });
  });
});

describe("steering inferred from reply calls, when nothing recorded it", () => {
  it("is still found: a reply call that answers a message other than the one that started the turn", () => {
    const spans = turnSpans({
      trace: "t1",
      agent: "paul",
      event: hex("opening"),
      root: ROOT,
      start: 0,
      end: 20,
      posts: [
        { replyTo: hex("opening"), text: "first answer", at: 4 },
        { replyTo: hex("s1"), text: "answer to the second message", at: 10 },
      ],
    });
    const turn = first(aggregate(spans));
    expect(turn.steered).toEqual([
      { eventId: hex("s1"), text: null, sender: null, senderPubkey: null, priority: null, delivered: null, endReason: null, at: null, source: "reply_call" },
    ]);
    expect(turn.handledMessages).toBe(2);
  });

  it("is completed by the record when there is one: the same message, now with its text", () => {
    const spans = turnSpans({
      trace: "t1",
      agent: "paul",
      event: hex("opening"),
      root: ROOT,
      start: 0,
      end: 20,
      posts: [
        { replyTo: hex("s1"), text: "answer one", at: 8 },
        { replyTo: hex("s9"), text: "answer to a message nothing recorded", at: 14 },
      ],
      steers: [{ eventId: hex("s1"), text: "the recorded text", at: 6, sender: "Elio Tran", priority: "now" }],
    });
    const turn = first(aggregate(spans));
    expect(turn.steered?.map((s) => [s.eventId, s.source, s.text])).toEqual([
      [hex("s1"), "span", "the recorded text"],
      [hex("s9"), "reply_call", null],
    ]);
    expect(turn.handledMessages).toBe(3);
  });
});

describe("a thread where nothing about steering is recorded", () => {
  // The real "Paul, four independent questions" thread: three messages were sent while the turn ran, and Phoenix has one
  // turn that answered the first message only.
  const spans = () =>
    turnSpans({ trace: "t1", agent: "ba-paul-twin", event: ROOT, root: ROOT, start: 0, end: 14.8, posts: [{ replyTo: ROOT, text: "Answers from standard SAP knowledge.", at: 10.7 }] });

  it("says so: one message handled, and steered messages are not recorded in this trace", () => {
    const t = aggregate(spans());
    expect(first(t).handledMessages).toBe(1);
    expect(first(t).steered).toEqual([]);
    expect(t.steeringRecorded).toBe(false);
  });

  it("says that steering is recorded once any turn of the thread has a record", () => {
    const t = aggregate([
      ...spans(),
      ...turnSpans({ trace: "t2", agent: "ba-ann-twin", event: hex("other"), root: ROOT, start: 30, end: 44, steers: [{ eventId: hex("s1"), text: "a steered one", at: 35 }] }),
    ]);
    expect(t.steeringRecorded).toBe(true);
  });

  it("does not take steering inferred from reply calls for a record", () => {
    const t = aggregate(
      turnSpans({
        trace: "t1",
        agent: "paul",
        event: hex("opening"),
        root: ROOT,
        start: 0,
        end: 20,
        posts: [{ replyTo: hex("s1"), text: "answers a message nothing recorded", at: 8 }],
      }),
    );
    expect(first(t).steered?.[0].source).toBe("reply_call");
    expect(t.steeringRecorded).toBe(false);
  });
});
