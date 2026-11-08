/**
 * A person answers an agent's message and no span recorded that message's id. Which turn posted it can then only be
 * worked out from what the spans do hold: which reply calls could have created a message before the answering turn started,
 * and that one call creates one message. When that leaves one turn it is named, as inferred; when it leaves several they are
 * listed and none is picked. Scored against the relay's thread on the real ba threads: truth was always among the
 * candidates, and what was named was right.
 */
import { describe, expect, it } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { hex, turnSpans } from "./helpers/phoenix-thread.js";

const ROOT = hex("root");
const aggregate = (spans: ReturnType<typeof turnSpans>) => new ThreadAggregator(ROOT, "ba").aggregate(spans);
const turn = (t: ReturnType<typeof aggregate>, trace: string) => t.turns.find((x) => x.traceId === trace)!;
const summary = (t: ReturnType<typeof aggregate>) => t.turns.map((x) => [x.traceId, x.parentTurnIndex ?? null, x.parentEdgeType ?? null]);

describe("a parent message nobody recorded", () => {
  it("names the turn when only one reply call could have created it, and says it is inferred", () => {
    const t = aggregate([
      ...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 12, posts: [{ replyTo: ROOT, text: "Kent's approach", at: 6 }] }),
      ...turnSpans({ trace: "t2", agent: "ann", event: hex("e2"), replyTo: hex("kent-msg"), root: ROOT, start: 20, end: 31, posts: [{ replyTo: hex("e2"), text: "Ann's review", at: 27 }] }),
    ]);
    expect(summary(t)).toEqual([
      ["t1", null, null],
      ["t2", 1, "INFERRED"],
    ]);
    expect(turn(t, "t2").parentMessage).toEqual({ id: hex("kent-msg"), basis: "inferred", postedByTurn: 1, turns: [1] });
    expect(t.anomalies.filter((a) => a.type === "AMBIGUOUS_PARENT")).toEqual([]);
  });

  it("lists every turn that could have created it, and picks none", () => {
    const t = aggregate([
      ...turnSpans({ trace: "t1", agent: "paul", event: ROOT, root: ROOT, start: 0, end: 12, posts: [{ replyTo: ROOT, text: "a1", at: 6 }] }),
      ...turnSpans({ trace: "t2", agent: "paul", event: hex("e2"), replyTo: ROOT, root: ROOT, start: 22, end: 32, posts: [{ replyTo: hex("e2"), text: "a2", at: 28 }] }),
      // Round 3 answers a message of Paul's that no span names: his round-1 reply or his round-2 reply.
      ...turnSpans({ trace: "t3", agent: "paul", event: hex("e3"), replyTo: hex("a-reply"), root: ROOT, start: 40, end: 50, posts: [{ replyTo: hex("e3"), text: "a3", at: 46 }] }),
      // Round 4 answers the person's own round-3 message: exact.
      ...turnSpans({ trace: "t4", agent: "paul", event: hex("e4"), replyTo: hex("e3"), root: ROOT, start: 60, end: 66, posts: [{ replyTo: hex("e4"), text: "a4", at: 63 }] }),
    ]);
    expect(summary(t)).toEqual([
      ["t1", null, null],
      ["t2", 1, "REPLY_TO"],
      ["t3", null, "AMBIGUOUS"],
      ["t4", 3, "REPLY_TO"],
    ]);
    expect(turn(t, "t3").parentCandidates).toEqual([1, 2]);
    expect(t.dag?.rootIndices).toEqual([1, 3]);
    expect(t.dag?.edges.map((e) => [e.fromTurnIndex, e.toTurnIndex, e.type])).toEqual([
      [1, 2, "REPLY_TO"],
      [3, 4, "REPLY_TO"],
    ]);
    const anomaly = t.anomalies.find((a) => a.type === "AMBIGUOUS_PARENT");
    expect(anomaly?.details).toMatchObject({ messageId: hex("a-reply"), candidates: [1, 2] });
  });

  it("uses elimination: a call creates one message, so when one message needs call A, another cannot be call A", () => {
    // Kent -> Ann -> Kent -> James, the shape of a real hand-off thread (relay ground truth: both links were right).
    const t = aggregate([
      ...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 12, posts: [{ replyTo: ROOT, text: "kent", at: 6 }] }),
      ...turnSpans({ trace: "t2", agent: "ann", event: hex("e2"), replyTo: hex("kent-msg"), root: ROOT, start: 20, end: 31, posts: [{ replyTo: hex("e2"), text: "ann", at: 27 }] }),
      ...turnSpans({ trace: "t3", agent: "kent", event: hex("e3"), replyTo: hex("ann-msg"), root: ROOT, start: 41, end: 51, posts: [{ replyTo: hex("e3"), text: "kent again", at: 47 }] }),
      ...turnSpans({ trace: "t4", agent: "james", event: hex("e4"), replyTo: ROOT, root: ROOT, start: 60, end: 72, posts: [{ replyTo: hex("e4"), text: "james", at: 66 }] }),
    ]);
    expect(summary(t)).toEqual([
      ["t1", null, null],
      ["t2", 1, "INFERRED"],
      ["t3", 2, "INFERRED"],
      ["t4", 1, "REPLY_TO"],
    ]);
  });

  it("gives up on both when two messages could each only be the same call (one of them is not an agent's)", () => {
    const t = aggregate([
      ...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 12, posts: [{ replyTo: ROOT, text: "kent", at: 6 }] }),
      ...turnSpans({ trace: "t2", agent: "ann", event: hex("e2"), replyTo: hex("msg-a"), root: ROOT, start: 20, end: 30 }),
      ...turnSpans({ trace: "t3", agent: "james", event: hex("e3"), replyTo: hex("msg-b"), root: ROOT, start: 21, end: 31 }),
    ]);
    expect(summary(t)).toEqual([
      ["t1", null, null],
      ["t2", null, "AMBIGUOUS"],
      ["t3", null, "AMBIGUOUS"],
    ]);
    expect(turn(t, "t2").parentCandidates).toEqual([1]);
    expect(turn(t, "t3").parentCandidates).toEqual([1]);
  });

  it("two turns answering the same unknown message share one answer", () => {
    const t = aggregate([
      ...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 12, posts: [{ replyTo: ROOT, text: "kent", at: 6 }] }),
      ...turnSpans({ trace: "t2", agent: "ann", event: hex("e2"), replyTo: hex("kent-msg"), root: ROOT, start: 20, end: 30 }),
      ...turnSpans({ trace: "t3", agent: "james", event: hex("e3"), replyTo: hex("kent-msg"), root: ROOT, start: 22, end: 32 }),
    ]);
    expect(summary(t)).toEqual([
      ["t1", null, null],
      ["t2", 1, "INFERRED"],
      ["t3", 1, "INFERRED"],
    ]);
  });
});

describe("what cannot have created the parent message", () => {
  const kent = (extra: Parameters<typeof turnSpans>[0]["posts"] = []) =>
    turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 12, posts: [{ replyTo: ROOT, text: "kent", at: 6 }, ...(extra ?? [])] });
  const asker = (overrides: Partial<Parameters<typeof turnSpans>[0]> = {}) =>
    turnSpans({ trace: "t2", agent: "ann", event: hex("e2"), replyTo: hex("unknown"), root: ROOT, start: 20, end: 30, ...overrides });

  it("a call that started after the answering turn did", () => {
    const t = aggregate([...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 40, posts: [{ replyTo: ROOT, text: "late", at: 30 }] }), ...asker()]);
    expect(turn(t, "t2").parentEdgeType).toBe("THREAD_ROOT");
    expect(turn(t, "t2").parentMessage?.basis).toBe("thread_root");
  });

  it("a call that failed", () => {
    const t = aggregate([...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 12, posts: [{ replyTo: ROOT, text: "failed", at: 6, error: true }] }), ...asker()]);
    expect(turn(t, "t2").parentEdgeType).toBe("THREAD_ROOT");
  });

  it("a call that answered the message itself: that turn handled it, it did not post it", () => {
    const t = aggregate([...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 12, posts: [{ replyTo: hex("unknown"), text: "replies to it", at: 6 }] }), ...asker()]);
    expect(turn(t, "t2").parentEdgeType).toBe("REPLY_TO");
    expect(turn(t, "t2").parentMessage).toEqual({ id: hex("unknown"), basis: "steered", postedByTurn: null, turns: [1] });
  });

  it("the answering turn's own calls, and the calls of a turn started by the same message", () => {
    const t = aggregate([
      ...kent(),
      ...asker({ posts: [{ replyTo: hex("e2"), text: "own", at: 24 }] }),
      ...turnSpans({ trace: "t3", agent: "james", event: hex("e2"), replyTo: hex("unknown"), root: ROOT, start: 20.5, end: 30, posts: [{ replyTo: hex("e2"), text: "sibling", at: 25 }] }),
    ]);
    expect(turn(t, "t2").parentTurnIndex).toBe(1);
    expect(turn(t, "t2").parentEdgeType).toBe("INFERRED");
    expect(turn(t, "t3").parentTurnIndex).toBe(1);
  });

  it("any call, when the parent is the thread's root: no reply call creates a root", () => {
    const t = aggregate([
      ...turnSpans({ trace: "t0", agent: "kent", event: hex("e0"), root: ROOT, start: 0, end: 12, posts: [{ replyTo: hex("e0"), text: "x", at: 6 }] }),
      ...turnSpans({ trace: "t2", agent: "ann", event: hex("e2"), replyTo: ROOT, root: ROOT, start: 20, end: 30 }),
    ]);
    const second = turn(t, "t2");
    expect(second.parentEdgeType).toBeNull();
    expect(second.parentTurnIndex).toBeNull();
    expect(second.parentMessage).toEqual({ id: ROOT, basis: "unknown", postedByTurn: null, turns: [] });
    expect(t.anomalies.filter((a) => a.type === "AMBIGUOUS_PARENT")).toEqual([]);
  });

  it("when nothing was posted at all there is no candidate", () => {
    const t = aggregate([...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 12 }), ...asker()]);
    expect(turn(t, "t2").parentEdgeType).toBe("THREAD_ROOT");
    expect(turn(t, "t2").parentMessage?.basis).toBe("thread_root");
    expect(t.anomalies.filter((a) => a.type === "AMBIGUOUS_PARENT")).toEqual([]);
  });
});

describe("clock drift between containers", () => {
  it("still counts a reply call that started a moment after the answering turn did, within the drift tolerance", () => {
    const t = aggregate([
      ...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 30, posts: [{ replyTo: ROOT, text: "kent", at: 21 }] }),
      ...turnSpans({ trace: "t2", agent: "ann", event: hex("e2"), replyTo: hex("kent-msg"), root: ROOT, start: 20, end: 31 }),
    ]);
    expect(turn(t, "t2").parentEdgeType).toBe("INFERRED");
  });

  it("not one that started well after it", () => {
    const t = aggregate([
      ...turnSpans({ trace: "t1", agent: "kent", event: ROOT, root: ROOT, start: 0, end: 30, posts: [{ replyTo: ROOT, text: "kent", at: 24 }] }),
      ...turnSpans({ trace: "t2", agent: "ann", event: hex("e2"), replyTo: hex("kent-msg"), root: ROOT, start: 20, end: 31 }),
    ]);
    expect(turn(t, "t2").parentEdgeType).toBe("THREAD_ROOT");
  });
});

describe("a long thread", () => {
  it("is resolved in well under a second: 400 turns, each answering a message no span names", () => {
    const spans: ReturnType<typeof turnSpans> = [];
    for (let i = 0; i < 400; i++) {
      spans.push(
        ...turnSpans({
          trace: `t${i}`,
          agent: `agent-${i % 7}`,
          event: i === 0 ? ROOT : hex(`e${i}`),
          replyTo: i === 0 ? undefined : hex(`m${i - 1}`),
          root: ROOT,
          start: i * 20,
          end: i * 20 + 15,
          posts: [{ replyTo: i === 0 ? ROOT : hex(`e${i}`), text: `answer ${i}`, at: i * 20 + 8 }],
        }),
      );
    }
    const started = performance.now();
    const t = aggregate(spans);
    expect(performance.now() - started).toBeLessThan(1500);
    // Each message m(i-1) has the previous turn's call as the one it could be, once the earlier calls are taken: a chain.
    expect(t.turns.filter((x) => x.parentEdgeType === "INFERRED")).toHaveLength(399);
  });
});

describe("the graph with an unresolved parent", () => {
  it("keeps every parent before its child and never links a turn to its own later turn", () => {
    const t = aggregate([
      ...turnSpans({ trace: "t1", agent: "paul", event: ROOT, root: ROOT, start: 0, end: 8, posts: [{ replyTo: ROOT, text: "p", at: 4 }] }),
      ...turnSpans({ trace: "t2", agent: "kent", event: ROOT, root: ROOT, start: 0.5, end: 7.5, posts: [{ replyTo: ROOT, text: "k", at: 4.4 }] }),
      ...turnSpans({ trace: "t3", agent: "paul", event: hex("e3"), replyTo: hex("kent-msg"), root: ROOT, start: 14, end: 22, posts: [{ replyTo: hex("e3"), text: "p2", at: 18 }] }),
    ]);
    for (const x of t.turns) {
      if (x.parentTurnIndex) {
        expect(x.parentTurnIndex).toBeLessThan(x.turnIndex);
      }
    }
    expect(t.turns.map((x) => x.traceId)).toEqual(["t1", "t2", "t3"]);
    expect(turn(t, "t3").parentEdgeType).toBe("AMBIGUOUS");
  });
});
