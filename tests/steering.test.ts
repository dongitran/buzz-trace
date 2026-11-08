/**
 * With `turn_handling: steer` a message that arrives while an agent's turn is running is injected into that turn, so it
 * never starts a trace of its own. The turn's `reply` calls still name the messages they answered, which is how the
 * extra messages show up: seen live in ba #consultant (Ann's turn answered two messages sent 12 s apart).
 */
import { describe, expect, it } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { TerminalRenderer } from "../src/formatters/terminal.js";
import { SpanNode } from "../src/models.js";

const ROOT = "0".repeat(64);
const E = (n: number) => String(n).padStart(64, "e");
const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 1, 0, 0) + s * 1000).toISOString();

type Post = { replyTo: string; text: string } | { shell: string };

function turn(o: { trace: string; agent: string; event: string; replyTo?: string; root?: string; start: number; end: number; posts: Post[] }): SpanNode[] {
  const root = o.root ?? ROOT;
  const spans = [
    new SpanNode({
      span_id: `${o.trace}-root`,
      trace_id: o.trace,
      parent_id: null,
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: at(o.start),
      end_time: at(o.end),
      status_code: "OK",
      attributes: {
        "session.id": root,
        "agent.name": o.agent,
        "nostr.event_id": o.event,
        "nostr.thread_root_id": root,
        ...(o.replyTo ? { "nostr.reply_to_id": o.replyTo } : {}),
        "input.value": `[Buzz event: @mention]\nEvent ID: ${o.event}\nContent: question\nTags: []`,
      },
    }),
  ];
  o.posts.forEach((post, i) => {
    const from = o.start + 2 + i * 3;
    spans.push(
      new SpanNode({
        span_id: `${o.trace}-p${i}`,
        trace_id: o.trace,
        parent_id: `${o.trace}-root`,
        name: "shell" in post ? "tool:run_command" : "tool:mcp__buzz-thread__reply",
        span_kind: "TOOL",
        start_time: at(from),
        end_time: at(from + 1),
        status_code: "OK",
        attributes:
          "shell" in post
            ? { "tool.name": "run_command", "input.value": JSON.stringify({ CommandLine: post.shell }) }
            : { "tool.name": "mcp__buzz-thread__reply", "tool.parameters.reply_to": post.replyTo, "tool.parameters.text": post.text },
      }),
    );
  });
  return spans;
}

const aggregate = (spans: SpanNode[]) => new ThreadAggregator(ROOT, "ba").aggregate(spans);

describe("a message steered into a running turn", () => {
  const steered = () =>
    aggregate([
      ...turn({
        trace: "t1",
        agent: "ann",
        event: E(3),
        replyTo: E(2),
        start: 0,
        end: 17,
        posts: [
          { replyTo: E(3), text: "answer to the first" },
          { replyTo: E(4), text: "answer to the one that arrived while it ran" },
        ],
      }),
    ]);

  it("is found from the reply calls: the turn handled two messages, one of them steered", () => {
    const t = steered().turns[0];
    expect(t.answeredEventIds).toEqual([E(3), E(4)]);
    expect(t.steeredEventIds).toEqual([E(4)]);
  });

  it("is said in the JSON, and in compact output as the number of messages the turn handled", () => {
    const thread = steered();
    expect(thread.toJSON().turns[0].steered_event_ids).toEqual([E(4)]);
    const compact = JSON.parse(new JsonRenderer().render(thread, { compact: true, flat: true }));
    expect(compact.turns[0].msgs).toBe(2);
  });

  it("is said in the terminal report", () => {
    expect(new TerminalRenderer(false).render(steered())).toContain("Handled  : 2 messages (1 arrived while the turn was running)");
  });

  it("makes a later reply to the steered message an exact child of the turn that handled it", () => {
    const thread = aggregate([
      ...turn({ trace: "t1", agent: "ann", event: E(3), replyTo: E(2), start: 0, end: 17, posts: [{ replyTo: E(3), text: "a" }, { replyTo: E(4), text: "b" }] }),
      ...turn({ trace: "t2", agent: "ann", event: E(5), replyTo: E(4), start: 40, end: 48, posts: [{ replyTo: E(5), text: "c" }] }),
    ]);
    const second = thread.turns.find((t) => t.traceId === "t2")!;
    const first = thread.turns.find((t) => t.traceId === "t1")!;
    expect(second.parentTurnIndex).toBe(first.turnIndex);
    expect(second.parentEdgeType).toBe("REPLY_TO");
  });

  it("does not take an answer to the thread root, to the trigger's parent, or to another turn's trigger for steering", () => {
    const thread = aggregate([
      ...turn({ trace: "t0", agent: "kent", event: E(1), start: -20, end: -10, posts: [{ replyTo: E(1), text: "first" }] }),
      ...turn({
        trace: "t1",
        agent: "kent",
        event: E(5),
        replyTo: E(1),
        start: 0,
        end: 10,
        posts: [
          { replyTo: ROOT, text: "to the root" },
          { replyTo: E(1), text: "to the trigger's parent, which also started the first turn" },
          { replyTo: E(5), text: "to its own trigger" },
        ],
      }),
    ]);
    const t = thread.turns.find((x) => x.traceId === "t1")!;
    expect(t.steeredEventIds).toEqual([]);
    expect(JSON.parse(new JsonRenderer().render(thread, { compact: true, flat: true })).turns[1].msgs).toBeUndefined();
  });

  it("reads the message answered from a shell command as well", () => {
    const shell = `buzz messages send --channel "c1" --reply-to "${E(4)}" --content "late answer"`;
    const t = aggregate(turn({ trace: "t1", agent: "phoenix-twin", event: E(3), start: 0, end: 10, posts: [{ shell }] })).turns[0];
    expect(t.answeredEventIds).toEqual([E(4)]);
    expect(t.steeredEventIds).toEqual([E(4)]);
  });
});
