/**
 * What a person or an AI reads about posted messages, parents and steering: a message id such as `212193a2…` with the turn
 * that posted it, per turn the ids it posted, and how many messages it handled. Where Phoenix recorded nothing the report
 * says so, and lists the candidate turns instead of picking one.
 */
import { describe, expect, it } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { MarkdownRenderer } from "../src/formatters/markdown.js";
import { TerminalRenderer } from "../src/formatters/terminal.js";
import { hex, THREAD_C, threadC, turnSpans } from "./helpers/phoenix-thread.js";

const short = (id: string) => `${id.slice(0, 8)}…`;
const aggregate = (spans: ReturnType<typeof turnSpans>, root = THREAD_C.root) => new ThreadAggregator(root, "ba").aggregate(spans);
const terminal = (t: ReturnType<typeof aggregate>) => new TerminalRenderer(false).render(t);
const compact = (t: ReturnType<typeof aggregate>) => JSON.parse(new JsonRenderer().render(t, { compact: true, flat: true }));

describe("terminal report: an old trace, where no id was recorded", () => {
  const text = terminal(aggregate(threadC()));

  it("names the parent message and lists the turns that could have posted it", () => {
    expect(text).toContain(`Reply To : message ${short(THREAD_C.kentMessage)} posted by Turn 1 or Turn 2: not recorded, so no parent is picked`);
  });

  it("says, for what each turn posted, that its id was not recorded", () => {
    expect(text).toContain('Posted   : id not recorded  "Kent Twin here. My first question');
    expect(text).toContain('Posted   : id not recorded  "Paul Twin: which master data domain');
  });

  it("says one message was handled, and that steered messages are not recorded in this trace", () => {
    expect(text).toContain("Handled  : 1 message — steered messages are not recorded in this trace");
  });
});

describe("terminal report: the producer recorded the ids", () => {
  const spans = threadC({ kentId: true, paulId: true });
  const text = terminal(aggregate(spans));

  it("shows the id of every message a turn posted", () => {
    expect(text).toContain(`Posted   : ${short(THREAD_C.kentMessage)}  "Kent Twin here`);
    expect(text).toContain(`Posted   : ${short(THREAD_C.paulMessage)}  "Paul Twin: which master data domain`);
  });

  it("shows the parent message and the turn that posted it", () => {
    expect(text).toContain(`Reply To : message ${short(THREAD_C.kentMessage)} posted by Turn 1 (ba-kent-twin)`);
    expect(text).not.toContain("not recorded, so no parent is picked");
  });
});

describe("terminal report: other ways a parent is known", () => {
  it("says an inferred parent is inferred, and why", () => {
    const text = terminal(aggregate(threadC({ paulId: true })));
    expect(text).toContain(`Reply To : message ${short(THREAD_C.kentMessage)} posted by Turn 1 (ba-kent-twin) — inferred: the only turn that could have posted it`);
  });

  it("says the message that started the turn the answer continues", () => {
    const spans = [
      ...turnSpans({ trace: "t1", agent: "paul", event: THREAD_C.root, root: THREAD_C.root, start: 0, end: 8 }),
      ...turnSpans({ trace: "t2", agent: "paul", event: hex("e2"), replyTo: THREAD_C.root, root: THREAD_C.root, start: 20, end: 26 }),
    ];
    expect(terminal(aggregate(spans))).toContain(`Reply To : message ${short(THREAD_C.root)} started Turn 1 (paul)`);
  });

  it("says every turn the message started, and which one the answer is linked to", () => {
    const spans = [
      ...turnSpans({ trace: "t1", agent: "ba-kent-twin", event: THREAD_C.root, root: THREAD_C.root, start: 0, end: 8 }),
      ...turnSpans({ trace: "t2", agent: "ba-paul-twin", event: THREAD_C.root, root: THREAD_C.root, start: 0.5, end: 8 }),
      ...turnSpans({ trace: "t3", agent: "ba-paul-twin", event: hex("e3"), replyTo: THREAD_C.root, root: THREAD_C.root, start: 20, end: 26 }),
    ];
    expect(terminal(aggregate(spans))).toContain(`Reply To : message ${short(THREAD_C.root)} started Turn 1 and Turn 2; linked to Turn 2 (ba-paul-twin)`);
  });

  it("says when a turn took the message in while it was running", () => {
    const spans = [
      ...turnSpans({ trace: "t1", agent: "paul", event: hex("opening"), root: THREAD_C.root, start: 0, end: 20, steers: [{ eventId: hex("s1"), text: "steered text", at: 6 }] }),
      ...turnSpans({ trace: "t2", agent: "paul", event: hex("later"), replyTo: hex("s1"), root: THREAD_C.root, start: 40, end: 48 }),
    ];
    expect(terminal(aggregate(spans))).toContain(`Reply To : message ${short(hex("s1"))} handled by Turn 1 (paul), steered into it`);
  });

  it("says when no turn is known to have posted it", () => {
    const spans = [...turnSpans({ trace: "t0", agent: "kent", event: hex("e0"), root: THREAD_C.root, start: 0, end: 8 }), ...turnSpans({ trace: "t2", agent: "ann", event: hex("e2"), replyTo: THREAD_C.root, root: THREAD_C.root, start: 20, end: 26 })];
    expect(terminal(aggregate(spans))).toContain(`Reply To : message ${short(THREAD_C.root)} (no turn is known to have posted it)`);
  });
});

describe("terminal report: steered messages", () => {
  const spans = turnSpans({
    trace: "t1",
    agent: "ba-paul-twin",
    event: hex("opening"),
    root: THREAD_C.root,
    start: 0,
    end: 20,
    steers: [
      { eventId: hex("s1"), text: "One more thing for the same email: mention the SAP client number.", at: 6, priority: "now" },
      { eventId: hex("s2"), text: "And please say who on our side will send the data model.", at: 11, priority: "later" },
      { eventId: hex("s3"), text: "Keep it under 100 words.", at: 12.5 },
    ],
  });
  const text = terminal(aggregate(spans));

  it("says how many messages the turn handled and how many were steered, with each one's id and text", () => {
    expect(text).toContain("Handled  : 4 messages (3 steered)");
    expect(text).toContain(`↳ steered ${short(hex("s1"))} (now) "One more thing for the same email: mention the SAP client number."`);
    expect(text).toContain(`↳ steered ${short(hex("s2"))} (later) "And please say who on our side will send the data model."`);
    expect(text).toContain(`↳ steered ${short(hex("s3"))} "Keep it under 100 words."`);
    expect(text).not.toContain("steered messages are not recorded");
  });

  it("says a steered message was only inferred from a reply call, and that its text is not recorded", () => {
    const inferred = turnSpans({ trace: "t1", agent: "paul", event: hex("opening"), root: THREAD_C.root, start: 0, end: 20, posts: [{ replyTo: hex("s1"), text: "answers the second", at: 9 }] });
    const out = terminal(aggregate(inferred));
    expect(out).toContain("Handled  : 2 messages (1 steered)");
    expect(out).toContain(`↳ steered ${short(hex("s1"))} (inferred from a reply call; text not recorded)`);
  });
});

describe("compact JSON", () => {
  it("gives the parent message, and for an unrecorded parent the candidates instead of a parent", () => {
    const third = compact(aggregate(threadC())).turns[2];
    expect(third.parent).toBeUndefined();
    expect(third.edge).toBe("ambiguous");
    expect(third.candidates).toEqual([1, 2]);
    expect(third.parent_msg).toBe(THREAD_C.kentMessage.slice(0, 8));
    expect(third.posted_ids).toBeUndefined();
  });

  it("says once, for the thread, that steered messages are not recorded", () => {
    expect(compact(aggregate(threadC())).steering).toBe("not_recorded");
    const withSteer = compact(aggregate(turnSpans({ trace: "t1", agent: "paul", event: hex("o"), root: THREAD_C.root, start: 0, end: 20, steers: [{ eventId: hex("s1"), text: "x", at: 5 }] })));
    expect(withSteer.steering).toBeUndefined();
  });

  it("gives the ids a turn posted, short, only when they were recorded; and the exact parent without an edge note", () => {
    const t = compact(aggregate(threadC({ kentId: true, paulId: true })));
    expect(t.turns[0].posted_ids).toEqual([THREAD_C.kentMessage.slice(0, 8)]);
    expect(t.turns[2].parent).toBe(1);
    expect(t.turns[2].edge).toBeUndefined();
  });

  it("gives the messages a turn handled, with the steered ones' ids and texts", () => {
    const t = compact(
      aggregate(
        turnSpans({
          trace: "t1",
          agent: "paul",
          event: hex("o"),
          root: THREAD_C.root,
          start: 0,
          end: 20,
          steers: [
            { eventId: hex("s1"), text: "First steered message", at: 5 },
            { eventId: hex("s2"), text: "Second steered message", at: 9 },
          ],
        }),
      ),
    );
    expect(t.turns[0].msgs).toBe(3);
    expect(t.turns[0].steered).toEqual([
      { id: hex("s1").slice(0, 8), text: "First steered message" },
      { id: hex("s2").slice(0, 8), text: "Second steered message" },
    ]);
  });

  it("stays small: a three-turn thread with nothing recorded costs under 700 characters a turn", () => {
    const flat = new JsonRenderer(0).render(aggregate(threadC()), { compact: true, flat: true });
    expect(flat.length / 3).toBeLessThan(700);
  });
});

describe("full JSON", () => {
  const json = aggregate(threadC({ kentId: true })).toJSON();

  it("adds the ids and the links to each turn, keeping the fields that were there", () => {
    const [kent, , third] = json.turns;
    expect(kent.posted_event_ids).toEqual([THREAD_C.kentMessage]);
    expect(kent.posts).toEqual([{ event_id: THREAD_C.kentMessage, reply_to: THREAD_C.root, text: expect.stringContaining("Kent Twin here"), at: expect.any(String) }]);
    expect(kent.answered_event_ids).toEqual([THREAD_C.root]);
    expect(kent.handled_messages).toBe(1);
    expect(third.reply_to).toBe(THREAD_C.kentMessage);
    expect(third.parent_turn_index).toBe(1);
    expect(third.parent_edge).toBe("REPLY_TO");
    expect(third.parent_message).toEqual({ id: THREAD_C.kentMessage, basis: "posted", posted_by_turn: 1, turns: [1] });
    expect(kent.posted).toHaveLength(1);
    // A runtime that writes posted ids writes steer spans: a steered message would show here.
    expect(json.steering).toBe("recorded");
    expect(kent.steering_recorded).toBe(true);
    expect(aggregate(threadC()).toJSON().steering).toBe("not_recorded");
  });

  it("says, for an unrecorded parent, that no parent was picked and who could have posted it", () => {
    const third = aggregate(threadC()).toJSON().turns[2];
    expect(third.parent_turn_index).toBeNull();
    expect(third.parent_edge).toBe("AMBIGUOUS");
    expect(third.parent_candidates).toEqual([1, 2]);
    expect(third.parent_alternatives).toEqual([1, 2]);
    expect(third.parent_message).toEqual({ id: THREAD_C.kentMessage, basis: "ambiguous", posted_by_turn: null, turns: [1, 2] });
  });

  it("lists the steered messages with id, text, sender, priority, time and where the record came from", () => {
    const j = aggregate(
      turnSpans({ trace: "t1", agent: "paul", event: hex("o"), root: THREAD_C.root, start: 0, end: 20, steers: [{ eventId: hex("s1"), text: "steered text", at: 6, sender: "Elio Tran", priority: "now" }] }),
    ).toJSON();
    expect(j.turns[0].handled_messages).toBe(2);
    expect(j.turns[0].steered_event_ids).toEqual([hex("s1")]);
    expect(j.turns[0].steered).toEqual([{ event_id: hex("s1"), text: "steered text", sender: "Elio Tran", priority: "now", at: "2026-11-08T04:46:18.000Z", source: "span" }]);
    expect(j.steering).toBe("recorded");
  });
});

describe("Markdown report", () => {
  it("has a table of message links: what started each turn, what it replies to, who posted that, what it posted", () => {
    const md = new MarkdownRenderer().render(aggregate(threadC({ kentId: true })));
    expect(md).toContain("| Turn | Agent | Handled | Started by | Replies to | Parent posted by | Posted |");
    expect(md).toMatch(new RegExp(`\\| \\*\\*3\\*\\* \\| \`ba-paul-twin\` \\| 1 \\| \`${hex("c-follow-up").slice(0, 8)}…\` \\| \`${THREAD_C.kentMessage.slice(0, 8)}…\` \\| Turn 1 \\| id not recorded \\|`));
    expect(md).toMatch(new RegExp(`\\| \\*\\*1\\*\\* \\| \`ba-kent-twin\` \\| 1 \\| .* \\| — \\| — \\| \`${THREAD_C.kentMessage.slice(0, 8)}…\` \\|`));
  });

  it("lists the candidates of an unrecorded parent, and says steering is not recorded", () => {
    const md = new MarkdownRenderer().render(aggregate(threadC()));
    expect(md).toContain("Turn 1 or Turn 2 (not recorded)");
    expect(md).toContain("Steered messages are not recorded in this trace");
  });

  it("draws the candidates as possible parents, not as parents", () => {
    const md = new MarkdownRenderer().render(aggregate(threadC()));
    expect(md).toContain('T1["Turn 1: ba-kent-twin"] -. possible parent .-> T3["Turn 3: ba-paul-twin"]');
    expect(md).toContain('T2["Turn 2: ba-paul-twin"] -. possible parent .-> T3["Turn 3: ba-paul-twin"]');
    expect(md).not.toMatch(/T[12]\[[^\]]*\] --> T3/);
  });

  it("lists the steered messages of a turn", () => {
    const md = new MarkdownRenderer().render(
      aggregate(turnSpans({ trace: "t1", agent: "paul", event: hex("o"), root: THREAD_C.root, start: 0, end: 20, steers: [{ eventId: hex("s1"), text: "steered text", at: 6, priority: "now" }] })),
    );
    expect(md).toContain("| 2 (1 steered) |");
    expect(md).toContain(`Turn 1 · paul also handled \`${hex("s1").slice(0, 8)}…\` (now): steered text`);
    expect(md).not.toContain("Steered messages are not recorded");
  });
});
