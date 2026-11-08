/**
 * Which turn posted a message. Phoenix does not hold the id of a posted message unless the producer records it: the reply
 * tool returns `posted (N characters)` and its span has the size of that, nothing else. The contract that makes it exact
 * is `nostr.posted_event_id` (64 hex) on the reply tool span, or `event_id <hex>` in the span's output text.
 */
import { describe, expect, it } from "vitest";
import {
  POSTED_EVENT_ID_ATTR,
  POSTED_EVENT_IDS_ATTR,
  POSTED_OUTPUT_ATTRS,
  postedIdFromOutput,
} from "../src/contract.js";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { hex, THREAD_C, threadC, turnSpans } from "./helpers/phoenix-thread.js";

const aggregate = (spans: ReturnType<typeof turnSpans>, root = THREAD_C.root) => new ThreadAggregator(root, "ba").aggregate(spans);
const byTrace = (t: ReturnType<typeof aggregate>, trace: string) => t.turns.find((x) => x.traceId === trace)!;

describe("the contract names", () => {
  it("are constants of one module", () => {
    expect(POSTED_EVENT_ID_ATTR).toBe("nostr.posted_event_id");
    expect(POSTED_EVENT_IDS_ATTR).toBe("nostr.posted_event_ids");
    expect([...POSTED_OUTPUT_ATTRS]).toEqual(["output.value", "tool.output"]);
  });
});

describe("postedIdFromOutput", () => {
  const id = hex("posted");
  it("takes the 64-hex id after the words event_id", () => {
    expect(postedIdFromOutput(`posted (251 characters) · event_id ${id}`)).toBe(id);
    expect(postedIdFromOutput(`posted (251 characters) event_id ${id.toUpperCase()}`)).toBe(id);
    expect(postedIdFromOutput(`event_id: ${id}`)).toBe(id);
    expect(postedIdFromOutput(`{"event_id":"${id}","ok":true}`)).toBe(id);
  });

  it("does not take any other id, the words Event ID, or a short or long hex string", () => {
    expect(postedIdFromOutput(`posted (251 characters) ${id}`)).toBeNull();
    expect(postedIdFromOutput(`Event ID: ${id}`)).toBeNull();
    expect(postedIdFromOutput(`event_id ${id.slice(0, 63)}`)).toBeNull();
    expect(postedIdFromOutput(`event_id ${id}0`)).toBeNull();
    expect(postedIdFromOutput("posted (251 characters)")).toBeNull();
    expect(postedIdFromOutput(undefined)).toBeNull();
    expect(postedIdFromOutput(42)).toBeNull();
  });
});

describe("reading the id a reply call recorded", () => {
  it("takes nostr.posted_event_id from the reply span, per call and per turn", () => {
    const t = aggregate(threadC({ kentId: true }));
    const kent = byTrace(t, "t1-kent");
    expect(kent.posts?.map((p) => p.eventId)).toEqual([THREAD_C.kentMessage]);
    expect(kent.postedEventIds).toEqual([THREAD_C.kentMessage]);
    expect(byTrace(t, "t2-paul").posts?.map((p) => p.eventId)).toEqual([null]);
    expect(byTrace(t, "t2-paul").postedEventIds).toEqual([]);
  });

  it("takes the id from event_id in the span's output.value or tool.output when the attribute is absent", () => {
    for (const outputAttr of ["output.value", "tool.output"] as const) {
      const spans = turnSpans({
        trace: "t1",
        agent: "paul",
        event: THREAD_C.root,
        root: THREAD_C.root,
        start: 0,
        end: 6,
        posts: [{ replyTo: THREAD_C.root, text: "an answer", at: 2, output: `posted (9 characters) · event_id ${hex("from-output")}`, outputAttr }],
      });
      expect(aggregate(spans).turns[0].postedEventIds).toEqual([hex("from-output")]);
    }
  });

  it("prefers the attribute over the output text", () => {
    const spans = turnSpans({
      trace: "t1",
      agent: "paul",
      event: THREAD_C.root,
      root: THREAD_C.root,
      start: 0,
      end: 6,
      posts: [{ replyTo: THREAD_C.root, text: "an answer", at: 2, eventId: hex("attribute"), output: `event_id ${hex("output")}` }],
    });
    expect(aggregate(spans).turns[0].posts?.[0].eventId).toBe(hex("attribute"));
  });

  it("reads output text only from a posting tool: another tool's event_id is not a posted message", () => {
    const spans = turnSpans({
      trace: "t1",
      agent: "paul",
      event: THREAD_C.root,
      root: THREAD_C.root,
      start: 0,
      end: 6,
      tools: [{ name: "mcp__buzz-thread__thread_read", at: 1, params: { root_event_id: THREAD_C.root }, output: `[{"event_id":"${hex("someone-else")}"}]` }],
    });
    expect(aggregate(spans).turns[0].postedEventIds).toEqual([]);
  });

  it("ignores a value that is not a 64-hex id, and an id recorded by a call that failed", () => {
    const spans = turnSpans({
      trace: "t1",
      agent: "paul",
      event: THREAD_C.root,
      root: THREAD_C.root,
      start: 0,
      end: 6,
      posts: [
        { replyTo: THREAD_C.root, text: "bad id", at: 1, eventId: "not-an-id" },
        { replyTo: THREAD_C.root, text: "failed", at: 3, eventId: hex("failed"), error: true },
      ],
    });
    const turn = aggregate(spans).turns[0];
    expect(turn.postedEventIds).toEqual([]);
    expect(turn.posts?.map((p) => p.eventId)).toEqual([null]);
  });

  it("still reads the plural attribute and an id on the turn's root span", () => {
    const spans = turnSpans({
      trace: "t1",
      agent: "paul",
      event: THREAD_C.root,
      root: THREAD_C.root,
      start: 0,
      end: 6,
      posts: [{ replyTo: THREAD_C.root, text: "an answer", at: 2 }],
      rootAttributes: { [POSTED_EVENT_IDS_ATTR]: `${hex("one")},${hex("two")}` },
    });
    expect(aggregate(spans).turns[0].postedEventIds).toEqual([hex("one"), hex("two")]);
  });
});

describe("which turn posted the parent message", () => {
  it("is exact when the reply span recorded the id: turn 3 answers the message turn 1 posted", () => {
    const t = aggregate(threadC({ kentId: true }));
    const third = byTrace(t, "t3-paul");
    const kent = byTrace(t, "t1-kent");
    expect(third.parentTurnIndex).toBe(kent.turnIndex);
    expect(third.parentEdgeType).toBe("REPLY_TO");
    expect(third.parentMessage).toEqual({ id: THREAD_C.kentMessage, basis: "posted", postedByTurn: kent.turnIndex, turns: [kent.turnIndex] });
    expect(t.anomalies.filter((a) => a.type === "AMBIGUOUS_PARENT")).toEqual([]);
  });

  it("is exact for the other message too: the follow-up answers Paul's recorded message, not Kent's", () => {
    const spans = [
      ...threadC({ kentId: true, paulId: true }).filter((s) => !s.traceId.startsWith("t3")),
      ...turnSpans({
        trace: "t3-kent",
        agent: "ba-kent-twin",
        event: THREAD_C.followUp,
        replyTo: THREAD_C.paulMessage,
        root: THREAD_C.root,
        start: 10.8,
        end: 18,
      }),
    ];
    const t = aggregate(spans);
    expect(byTrace(t, "t3-kent").parentTurnIndex).toBe(byTrace(t, "t2-paul").turnIndex);
    expect(byTrace(t, "t3-kent").parentMessage?.basis).toBe("posted");
  });

  it("does not choose between two turns when nothing recorded the id: both are candidates, no parent is picked", () => {
    const t = aggregate(threadC());
    const third = byTrace(t, "t3-paul");
    expect(third.parentTurnIndex).toBeNull();
    expect(third.parentEdgeType).toBe("AMBIGUOUS");
    expect(third.parentCandidates).toEqual([byTrace(t, "t1-kent").turnIndex, byTrace(t, "t2-paul").turnIndex].sort());
    expect(third.parentMessage).toEqual({
      id: THREAD_C.kentMessage,
      basis: "ambiguous",
      postedByTurn: null,
      turns: third.parentCandidates,
    });
    expect(t.dag?.edges).toEqual([]);
    const anomaly = t.anomalies.find((a) => a.type === "AMBIGUOUS_PARENT");
    expect(anomaly?.severity).toBe("INFO");
    expect(anomaly?.turnIndex).toBe(third.turnIndex);
    expect(anomaly?.message).toContain(`${THREAD_C.kentMessage.slice(0, 8)}…`);
    expect(anomaly?.message).toContain("nostr.posted_event_id");
    expect(anomaly?.message).not.toContain("--messages");
  });

  it("looks only among calls whose id is not recorded: Paul's recorded id leaves Kent's call as the only candidate", () => {
    const t = aggregate(threadC({ paulId: true }));
    const third = byTrace(t, "t3-paul");
    expect(third.parentTurnIndex).toBe(byTrace(t, "t1-kent").turnIndex);
    expect(third.parentEdgeType).toBe("INFERRED");
    expect(third.parentMessage?.basis).toBe("inferred");
    expect(third.parentMessage?.postedByTurn).toBe(byTrace(t, "t1-kent").turnIndex);
  });

  it("knows a turn's two posts, each with its id", () => {
    const spans = turnSpans({
      trace: "t1",
      agent: "paul",
      event: THREAD_C.root,
      root: THREAD_C.root,
      start: 0,
      end: 12,
      posts: [
        { replyTo: THREAD_C.root, text: "first", at: 2, eventId: hex("m1") },
        { replyTo: THREAD_C.root, text: "second", at: 6, eventId: hex("m2") },
      ],
    });
    const turn = aggregate(spans).turns[0];
    expect(turn.postedEventIds).toEqual([hex("m1"), hex("m2")]);
    expect(turn.posts?.map((p) => [p.text, p.eventId])).toEqual([
      ["first", hex("m1")],
      ["second", hex("m2")],
    ]);
  });
});
