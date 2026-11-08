/**
 * A trace written before a runtime recorded `nostr.posted_event_id` holds no id for a posted message. Whoever knows the ids
 * can complete the trace inside Phoenix: a span annotation named `nostr.posted_event_id` on each reply span, labelled with the
 * id of the message the call posted. buzz-trace only reads such annotations; here, what it does with them once they are on the
 * spans (the client that fetches them is tested in span-annotations.test.ts).
 */
import { describe, expect, it } from "vitest";
import { POSTED_EVENT_ID_ANNOTATION, POSTED_EVENT_ID_ATTR, postedIdFromAnnotations } from "../src/contract.js";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { MarkdownRenderer } from "../src/formatters/markdown.js";
import { TerminalRenderer } from "../src/formatters/terminal.js";
import { type SpanAnnotation, SpanNode } from "../src/models.js";
import { annotate, hex, type PostSpec, THREAD_C, threadC, turnSpans } from "./helpers/phoenix-thread.js";

const short = (id: string) => `${id.slice(0, 8)}…`;
const aggregate = (spans: SpanNode[], root = THREAD_C.root) => new ThreadAggregator(root, "ba").aggregate(spans);
const byTrace = (t: ReturnType<typeof aggregate>, trace: string) => t.turns.find((x) => x.traceId === trace)!;
const terminal = (t: ReturnType<typeof aggregate>) => new TerminalRenderer(false).render(t);
const compact = (t: ReturnType<typeof aggregate>) => JSON.parse(new JsonRenderer().render(t, { compact: true, flat: true }));

describe("a span's annotations", () => {
  it("are empty until a client attaches some", () => {
    expect(new SpanNode({ span_id: "s1", trace_id: "t1", name: "tool:x" }).annotations).toEqual([]);
  });
});

describe("postedIdFromAnnotations", () => {
  const A = hex("annotation-a");
  const B = hex("annotation-b");
  const note = (label: string | null, at: number | null = 1000, name: string = POSTED_EVENT_ID_ANNOTATION): SpanAnnotation => ({ name, label, at });

  it("is named like the attribute", () => {
    expect(POSTED_EVENT_ID_ANNOTATION).toBe("nostr.posted_event_id");
    expect(POSTED_EVENT_ID_ANNOTATION).toBe(POSTED_EVENT_ID_ATTR);
  });

  it("takes the 64-hex label of the annotation", () => {
    expect(postedIdFromAnnotations([note(A)])).toBe(A);
  });

  it("lower-cases the id and ignores spaces around it", () => {
    expect(postedIdFromAnnotations([note(A.toUpperCase())])).toBe(A);
    expect(postedIdFromAnnotations([note(`  ${A}\n`)])).toBe(A);
  });

  it("takes no label that is not exactly one id", () => {
    for (const label of [null, "", "abc", A.slice(0, 63), `${A}0`, `${A},${B}`, `${A} ${B}`, `z${A.slice(1)}`, "event_id " + A]) {
      expect(postedIdFromAnnotations([note(label)]), String(label)).toBeNull();
    }
  });

  it("ignores annotations of another name", () => {
    expect(postedIdFromAnnotations([note(A, 1000, "other.name")])).toBeNull();
    // a newer annotation of another name is not "the latest" of this one
    expect(postedIdFromAnnotations([note(A, 1000), note(B, 2000, "other.name")])).toBe(A);
  });

  it("takes the latest: a newer id replaces an older one, whatever the order they are listed in", () => {
    expect(postedIdFromAnnotations([note(A, 1000), note(B, 2000)])).toBe(B);
    expect(postedIdFromAnnotations([note(B, 2000), note(A, 1000)])).toBe(B);
  });

  it("ignores a latest annotation whose label is no id, and does not fall back to an older one", () => {
    expect(postedIdFromAnnotations([note(A, 1000), note("retracted", 2000)])).toBeNull();
    expect(postedIdFromAnnotations([note(A, 1000), note("", 2000)])).toBeNull();
    expect(postedIdFromAnnotations([note(A, 1000), note(null, 2000)])).toBeNull();
    // an older invalid one does not matter
    expect(postedIdFromAnnotations([note("retracted", 1000), note(A, 2000)])).toBe(A);
  });

  it("uses none when the newest annotations are equally new and disagree; one when they agree", () => {
    expect(postedIdFromAnnotations([note(A, 1000), note(B, 1000)])).toBeNull();
    expect(postedIdFromAnnotations([note(A, 1000), note("nope", 1000)])).toBeNull();
    expect(postedIdFromAnnotations([note(A, 1000), note(A.toUpperCase(), 1000)])).toBe(A);
  });

  it("reads an annotation that has no time as the oldest", () => {
    expect(postedIdFromAnnotations([note(A, null), note(B, 5)])).toBe(B);
    expect(postedIdFromAnnotations([note(A, null)])).toBe(A);
    expect(postedIdFromAnnotations([note(A, null), note(B, null)])).toBeNull();
  });

  it("has nothing from no annotations", () => {
    expect(postedIdFromAnnotations([])).toBeNull();
    expect(postedIdFromAnnotations(undefined)).toBeNull();
  });
});

/** The old thread (project ba) completed the way the owner's operator tool did it: an annotation on each reply span. */
function annotatedThreadC(): SpanNode[] {
  const spans = threadC();
  annotate(spans, "t1-kent-post0", THREAD_C.kentMessage);
  annotate(spans, "t2-paul-post0", THREAD_C.paulMessage);
  annotate(spans, "t3-paul-post0", hex("c-paul-answer"));
  return spans;
}

describe("an old thread completed with annotations", () => {
  const t = aggregate(annotatedThreadC());

  it("reads the id of each reply call from its annotation, and says that is where it came from", () => {
    expect(byTrace(t, "t1-kent").posts).toMatchObject([{ eventId: THREAD_C.kentMessage, eventIdSource: "annotation" }]);
    expect(byTrace(t, "t2-paul").posts).toMatchObject([{ eventId: THREAD_C.paulMessage, eventIdSource: "annotation" }]);
    expect(byTrace(t, "t3-paul").posts).toMatchObject([{ eventId: hex("c-paul-answer"), eventIdSource: "annotation" }]);
    expect(byTrace(t, "t1-kent").postedEventIds).toEqual([THREAD_C.kentMessage]);
    expect(byTrace(t, "t3-paul").postedEventIds).toEqual([hex("c-paul-answer")]);
  });

  it("makes the parent of turn 3 exact: the message Kent posted, no longer ambiguous", () => {
    const third = byTrace(t, "t3-paul");
    expect(third.parentMessage).toEqual({ id: THREAD_C.kentMessage, basis: "annotation", postedByTurn: 1, turns: [1] });
    expect(third.parentTurnIndex).toBe(1);
    expect(third.parentEdgeType).toBe("REPLY_TO");
    expect(third.parentCandidates).toBeUndefined();
    expect(t.anomalies.map((a) => a.type)).not.toContain("AMBIGUOUS_PARENT");
  });

  it("needs only the annotation on the call that posted the parent message", () => {
    // Paul's own calls are not annotated: the follow-up still links to Kent's turn, because Kent's call is.
    const spans = threadC();
    annotate(spans, "t1-kent-post0", THREAD_C.kentMessage);
    const partial = byTrace(aggregate(spans), "t3-paul");
    expect(partial.parentMessage?.basis).toBe("annotation");
  });

  it("narrows what is deduced the way a recorded id does: a call known to have created one message did not create another", () => {
    // Only Paul's first call is annotated. As with an attribute, Kent's call is then the one call left that could have
    // created the message turn 3 replies to: a deduction (inferred), not a record.
    const spans = threadC();
    annotate(spans, "t2-paul-post0", THREAD_C.paulMessage);
    const third = byTrace(aggregate(spans), "t3-paul");
    expect(third.parentMessage).toEqual({ id: THREAD_C.kentMessage, basis: "inferred", postedByTurn: 1, turns: [1] });
    expect(third.parentEdgeType).toBe("INFERRED");
  });

  it("does not take a turn that starts while the poster is still running for an overlap, as with a recorded id", () => {
    const spans = [
      ...turnSpans({
        trace: "t1",
        agent: "kent",
        event: THREAD_C.root,
        root: THREAD_C.root,
        start: 0,
        end: 6.4,
        posts: [{ replyTo: THREAD_C.root, text: "Kent answers", at: 3.3 }],
      }),
      ...turnSpans({ trace: "t2", agent: "paul", event: hex("follow"), replyTo: THREAD_C.kentMessage, root: THREAD_C.root, start: 4.5, end: 12 }),
    ];
    annotate(spans, "t1-post0", THREAD_C.kentMessage);
    const result = aggregate(spans);
    expect(byTrace(result, "t2").parentMessage?.basis).toBe("annotation");
    expect(result.anomalies.map((a) => a.type)).not.toContain("CAUSAL_OVERLAP");
    expect(result.anomalies.map((a) => a.type)).not.toContain("CLOCK_SKEW");
  });
});

describe("which id a reply call has when several things say", () => {
  const spans = (post: Partial<PostSpec>) =>
    turnSpans({ trace: "t1", agent: "paul", event: THREAD_C.root, root: THREAD_C.root, start: 0, end: 6, posts: [{ replyTo: THREAD_C.root, text: "an answer", at: 2, ...post }] });
  const post = (nodes: SpanNode[]) => aggregate(nodes).turns[0].posts![0];

  it("takes the attribute over the annotation", () => {
    const nodes = spans({ eventId: hex("from-attribute") });
    annotate(nodes, "t1-post0", hex("from-annotation"));
    expect(post(nodes)).toMatchObject({ eventId: hex("from-attribute"), eventIdSource: "attribute" });
  });

  it("takes the annotation over the id in the output text", () => {
    const nodes = spans({ output: `posted (9 characters) · event_id ${hex("from-output")}` });
    annotate(nodes, "t1-post0", hex("from-annotation"));
    expect(post(nodes)).toMatchObject({ eventId: hex("from-annotation"), eventIdSource: "annotation" });
  });

  it("takes the id in the output text when nothing is annotated", () => {
    const nodes = spans({ output: `posted (9 characters) · event_id ${hex("from-output")}` });
    expect(post(nodes)).toMatchObject({ eventId: hex("from-output"), eventIdSource: "output" });
  });

  it("has none, and says nothing of one, when no annotation and nothing else records it", () => {
    expect(post(spans({}))).toMatchObject({ eventId: null });
    expect(post(spans({})).eventIdSource).toBeUndefined();
  });

  it("takes no annotation whose label is no id", () => {
    const nodes = spans({});
    annotate(nodes, "t1-post0", "not-an-id");
    expect(post(nodes).eventId).toBeNull();
  });

  it("takes the latest of two annotations on the call, and none when the latest is no id", () => {
    const newer = spans({});
    annotate(newer, "t1-post0", hex("first"), { at: 1000 });
    annotate(newer, "t1-post0", hex("second"), { at: 2000 });
    expect(post(newer).eventId).toBe(hex("second"));

    const retracted = spans({});
    annotate(retracted, "t1-post0", hex("first"), { at: 1000 });
    annotate(retracted, "t1-post0", "", { at: 2000 });
    expect(post(retracted).eventId).toBeNull();
  });
});

describe("what an annotation does not do", () => {
  it("is not read on a call that failed: a call that failed created no message", () => {
    const nodes = turnSpans({ trace: "t1", agent: "paul", event: THREAD_C.root, root: THREAD_C.root, start: 0, end: 6, posts: [{ replyTo: THREAD_C.root, text: "an answer", at: 2, error: true }] });
    annotate(nodes, "t1-post0", hex("failed-call"));
    const turn = aggregate(nodes).turns[0];
    expect(turn.posts).toEqual([]);
    expect(turn.postedEventIds).toEqual([]);
  });

  it("is not read on a tool that posts nothing", () => {
    const nodes = turnSpans({ trace: "t1", agent: "paul", event: THREAD_C.root, root: THREAD_C.root, start: 0, end: 6, tools: [{ name: "Bash", at: 1, params: { command: "ls" } }] });
    annotate(nodes, "t1-tool0", hex("not-a-post"));
    const turn = aggregate(nodes).turns[0];
    expect(turn.postedEventIds).toEqual([]);
    expect(turn.posts).toEqual([]);
  });

  it("is read on a shell call that posts with `buzz messages send`, as on a reply tool", () => {
    const nodes = turnSpans({
      trace: "t1",
      agent: "paul",
      event: THREAD_C.root,
      root: THREAD_C.root,
      start: 0,
      end: 6,
      tools: [{ name: "Bash", at: 1, params: { command: `buzz messages send --reply-to ${THREAD_C.root} --content "done"` } }],
    });
    annotate(nodes, "t1-tool0", hex("sent-by-shell"));
    expect(aggregate(nodes).turns[0].postedEventIds).toEqual([hex("sent-by-shell")]);
  });

  it("is not evidence that the runtime records steered messages: an old trace stays 'not recorded'", () => {
    const t = aggregate(annotatedThreadC());
    expect(t.steeringRecorded).toBe(false);
    expect(t.turns.map((x) => x.steeringRecorded)).toEqual([false, false, false]);
    expect(terminal(t)).toContain("Handled  : 1 message — steered messages are not recorded in this trace");
    expect(t.toJSON().steering).toBe("not_recorded");
  });

  it("does not hide what an id the runtime did record shows: the same agent elsewhere in the thread", () => {
    // Paul's first call records its id (attribute); Kent's is only annotated. Paul is seen to write ids, Kent is not.
    const spans = threadC({ paulId: true });
    annotate(spans, "t1-kent-post0", THREAD_C.kentMessage);
    const t = aggregate(spans);
    expect(byTrace(t, "t1-kent").steeringRecorded).toBe(false);
    expect(byTrace(t, "t2-paul").steeringRecorded).toBe(true);
    expect(byTrace(t, "t3-paul").steeringRecorded).toBe(true);
  });
});

describe("a thread nobody completed", () => {
  it("says, in the ambiguous-parent finding, that the id can also be written afterwards as a span annotation", () => {
    const finding = aggregate(threadC()).anomalies.find((a) => a.type === "AMBIGUOUS_PARENT")!;
    expect(finding.message).toContain("nostr.posted_event_id");
    expect(finding.message).toContain("span annotation");
  });
});

describe("the reports of an old thread completed with annotations", () => {
  const t = aggregate(annotatedThreadC());

  it("terminal: the parent line names the turn that posted the message, and says the id is from a span annotation", () => {
    const text = terminal(t);
    expect(text).toContain(`Reply To : message ${short(THREAD_C.kentMessage)} posted by Turn 1 (ba-kent-twin) — id from a span annotation`);
    expect(text).not.toContain("not recorded, so no parent is picked");
    expect(text).not.toContain("which no span records as posted");
    expect(text).not.toContain("inferred");
  });

  it("terminal: every turn shows the id of what it posted, and that it is from a span annotation", () => {
    const text = terminal(t);
    expect(text).toContain(`Posted   : ${short(THREAD_C.kentMessage)} (span annotation)  "Kent Twin here`);
    expect(text).toContain(`Posted   : ${short(THREAD_C.paulMessage)} (span annotation)  "Paul Twin: which master data domain`);
    expect(text).toContain(`Posted   : ${short(hex("c-paul-answer"))} (span annotation)  "Yes, I would keep mine first.`);
    expect(text).not.toContain("id not recorded");
  });

  it("Markdown: the link table names the poster and marks what came from an annotation", () => {
    const md = new MarkdownRenderer().render(t);
    expect(md).toContain(`\`${short(THREAD_C.kentMessage)}\` | Turn 1 (annotation) |`);
    expect(md).toContain(`\`${short(THREAD_C.kentMessage)}\` (annotation)`);
    expect(md).not.toContain("possible parent");
  });

  it("full JSON: the parent's basis is annotation, and each id read from an annotation says so", () => {
    const json = t.toJSON();
    expect(json.turns[2].parent_message).toEqual({ id: THREAD_C.kentMessage, basis: "annotation", posted_by_turn: 1, turns: [1] });
    expect(json.turns[2].parent_turn_index).toBe(1);
    expect(json.turns[2].parent_edge).toBe("REPLY_TO");
    expect(json.turns[2].parent_candidates).toBeUndefined();
    expect(json.turns[0].posts).toEqual([
      { event_id: THREAD_C.kentMessage, event_id_source: "annotation", reply_to: THREAD_C.root, text: expect.stringContaining("Kent Twin here"), at: expect.any(String) },
    ]);
    expect(json.turns[0].posted_event_ids).toEqual([THREAD_C.kentMessage]);
    expect(json.anomalies.map((a: { type: string }) => a.type)).not.toContain("AMBIGUOUS_PARENT");
  });

  it("compact JSON: the parent turn, the parent message, and that the link rests on an annotation", () => {
    const third = compact(t).turns[2];
    expect(third).toMatchObject({ turn: 3, parent: 1, parent_msg: THREAD_C.kentMessage.slice(0, 8), parent_basis: "annotation" });
    expect(third.edge).toBeUndefined();
    expect(third.candidates).toBeUndefined();
  });

  it("leaves every report of a thread whose runtime recorded the ids exactly as it was", () => {
    const recorded = aggregate(threadC({ kentId: true, paulId: true }));
    expect(terminal(recorded)).not.toMatch(/annotation/);
    expect(new MarkdownRenderer().render(recorded)).not.toMatch(/annotation/);
    expect(JSON.stringify(recorded.toJSON())).not.toMatch(/annotation|event_id_source/);
    expect(JSON.stringify(compact(recorded))).not.toMatch(/annotation|parent_basis/);
  });
});
