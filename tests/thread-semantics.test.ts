/**
 * How a Buzz thread's turns link up, on spans shaped like the ones claude-agent-acp's Phoenix telemetry writes:
 * one trace per turn, a root `agent_turn` span carrying `nostr.event_id` (the message that started the turn),
 * `nostr.reply_to_id` (what that message replies to), `nostr.thread_root_id`, and one `tool:` span per tool call.
 */
import { describe, expect, it } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { SpanNode } from "../src/models.js";
import { hex } from "./helpers/phoenix-thread.js";

const ROOT = "0".repeat(64);
const id = (n: number | string) => String(n).padStart(64, "f");

interface TurnSpec {
  trace: string;
  agent: string;
  event: string;
  replyTo?: string;
  root?: string;
  start: string;
  end: string;
  content?: string;
  posted?: { text: string; replyTo: string; eventId?: string };
}

function turn(spec: TurnSpec): SpanNode[] {
  const root = spec.root ?? spec.event;
  const prompt = [
    "[Buzz event: @mention]",
    `Event ID: ${spec.event}`,
    "Channel: consultant (#c06880bc-9779-4615-85f0-b74d61cbdd03)",
    "Kind: 9",
    `From: Elio Tran (npub: npub1x, hex: ${"e".repeat(64)})`,
    "Time: 2026-11-08T01:12:10+00:00",
    `Content: ${spec.content ?? `question for ${spec.agent}`}`,
    `Tags: [["h","c06880bc-9779-4615-85f0-b74d61cbdd03"]]`,
    spec.replyTo ? `Parsed: parent=${spec.replyTo}, root=${root}, mentions=[]` : "Parsed: mentions=[]",
  ].join("\n");
  const spans = [
    new SpanNode({
      span_id: `${spec.trace}-root`,
      trace_id: spec.trace,
      parent_id: null,
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: spec.start,
      end_time: spec.end,
      status_code: "OK",
      attributes: {
        "session.id": root,
        "agent.name": spec.agent,
        "input.value": prompt,
        "output.value": `I replied in the thread (${spec.agent}).`,
        "nostr.event_id": spec.event,
        "nostr.thread_root_id": root,
        "nostr.sender_name": "Elio Tran",
        ...(spec.replyTo ? { "nostr.reply_to_id": spec.replyTo } : {}),
      },
    }),
    new SpanNode({
      span_id: `${spec.trace}-llm`,
      trace_id: spec.trace,
      parent_id: `${spec.trace}-root`,
      name: "llm:sonnet",
      span_kind: "LLM",
      start_time: spec.start,
      end_time: spec.end,
      status_code: "OK",
      attributes: { "llm.model_name": "sonnet", "llm.token_count.prompt": 1000, "llm.token_count.completion": 50 },
    }),
  ];
  if (spec.posted) {
    spans.push(
      new SpanNode({
        span_id: `${spec.trace}-reply`,
        trace_id: spec.trace,
        parent_id: `${spec.trace}-root`,
        name: "tool:mcp__buzz-thread__reply",
        span_kind: "TOOL",
        start_time: spec.start,
        end_time: spec.end,
        status_code: "OK",
        attributes: {
          "tool.name": "mcp__buzz-thread__reply",
          "tool.parameters.reply_to": spec.posted.replyTo,
          "tool.parameters.text": spec.posted.text,
          "input.value": JSON.stringify({ reply_to: spec.posted.replyTo, text: spec.posted.text }),
          ...(spec.posted.eventId ? { "nostr.posted_event_id": spec.posted.eventId } : {}),
        },
      }),
    );
  }
  return spans;
}

const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 1, 12, 0) + s * 1000).toISOString();

function parents(spans: SpanNode[]) {
  const telemetry = new ThreadAggregator(ROOT, "ba").aggregate(spans);
  return { telemetry, byAgentEvent: telemetry.turns.map((t) => [t.agentName, t.parentTurnIndex ?? null, t.parentEdgeType ?? null]) };
}

describe("Buzz thread semantics", () => {
  it("treats agents started by the same message as siblings, not as replies to each other", () => {
    const spans = [
      ...turn({ trace: "t-paul", agent: "paul", event: ROOT, start: at(0.4), end: at(7), posted: { text: "Paul's answer", replyTo: ROOT } }),
      ...turn({ trace: "t-kent", agent: "kent", event: ROOT, start: at(0), end: at(6), posted: { text: "Kent's answer", replyTo: ROOT } }),
    ];
    const { telemetry } = parents(spans);
    expect(telemetry.turns.map((t) => t.parentTurnIndex ?? null)).toEqual([null, null]);
    expect(telemetry.dag?.edges).toEqual([]);
    expect(telemetry.anomalies.filter((a) => a.type === "CLOCK_SKEW" || a.type === "CAUSAL_OVERLAP")).toEqual([]);
  });

  it("chains one agent's rounds; a person's answer to the agent's own reply, which no span names, picks no parent", () => {
    const spans = [
      ...turn({ trace: "t1", agent: "paul", event: ROOT, start: at(0), end: at(12), posted: { text: "a1", replyTo: ROOT } }),
      ...turn({ trace: "t2", agent: "paul", event: id(2), replyTo: ROOT, root: ROOT, start: at(22), end: at(32), posted: { text: "a2", replyTo: id(2) } }),
      // Round 3 answers a reply of Paul's that no span names: his round-1 reply or his round-2 reply.
      ...turn({ trace: "t3", agent: "paul", event: id(3), replyTo: id("a2reply"), root: ROOT, start: at(40), end: at(50), posted: { text: "a3", replyTo: id(3) } }),
      // Round 4 answers the person's own round-3 message.
      ...turn({ trace: "t4", agent: "paul", event: id(4), replyTo: id(3), root: ROOT, start: at(60), end: at(66), posted: { text: "a4", replyTo: id(4) } }),
    ];
    const { byAgentEvent, telemetry } = parents(spans);
    expect(byAgentEvent).toEqual([
      ["paul", null, null],
      ["paul", 1, "REPLY_TO"],
      ["paul", null, "AMBIGUOUS"],
      ["paul", 3, "REPLY_TO"],
    ]);
    expect(telemetry.turns[2].parentCandidates).toEqual([1, 2]);
  });

  it("chains the same rounds exactly when the reply spans record the ids they posted", () => {
    const spans = [
      ...turn({ trace: "t1", agent: "paul", event: ROOT, start: at(0), end: at(12), posted: { text: "a1", replyTo: ROOT, eventId: hex("a1-msg") } }),
      ...turn({ trace: "t2", agent: "paul", event: id(2), replyTo: ROOT, root: ROOT, start: at(22), end: at(32), posted: { text: "a2", replyTo: id(2), eventId: hex("a2-msg") } }),
      ...turn({ trace: "t3", agent: "paul", event: id(3), replyTo: hex("a2-msg"), root: ROOT, start: at(40), end: at(50), posted: { text: "a3", replyTo: id(3), eventId: hex("a3-msg") } }),
      ...turn({ trace: "t4", agent: "paul", event: id(4), replyTo: hex("a3-msg"), root: ROOT, start: at(60), end: at(66), posted: { text: "a4", replyTo: id(4) } }),
    ];
    const { byAgentEvent, telemetry } = parents(spans);
    expect(byAgentEvent).toEqual([
      ["paul", null, null],
      ["paul", 1, "REPLY_TO"],
      ["paul", 2, "REPLY_TO"],
      ["paul", 3, "REPLY_TO"],
    ]);
    expect(telemetry.dag?.branches).toHaveLength(1);
  });

  it("follows a hand-off between agents in one thread", () => {
    const spans = [
      ...turn({ trace: "k1", agent: "kent", event: ROOT, start: at(0), end: at(15), posted: { text: "k", replyTo: ROOT } }),
      ...turn({ trace: "a2", agent: "ann", event: id(2), replyTo: id("kreply"), root: ROOT, start: at(25), end: at(36), posted: { text: "a", replyTo: id(2) } }),
      ...turn({ trace: "k3", agent: "kent", event: id(3), replyTo: id("areply"), root: ROOT, start: at(45), end: at(55), posted: { text: "k2", replyTo: id(3) } }),
      ...turn({ trace: "j4", agent: "james", event: id(4), replyTo: ROOT, root: ROOT, start: at(60), end: at(72), posted: { text: "j", replyTo: id(4) } }),
    ];
    const { byAgentEvent } = parents(spans);
    expect(byAgentEvent).toEqual([
      ["kent", null, null],
      ["ann", 1, "INFERRED"],
      ["kent", 2, "INFERRED"],
      ["james", 1, "REPLY_TO"],
    ]);
  });

  it("links a reply exactly to the turn that posted it when the span records the posted event id", () => {
    const spans = [
      ...turn({ trace: "p", agent: "paul", event: ROOT, start: at(0), end: at(8), posted: { text: "p", replyTo: ROOT, eventId: hex("p-msg") } }),
      ...turn({ trace: "k", agent: "kent", event: ROOT, start: at(0), end: at(9), posted: { text: "k", replyTo: ROOT, eventId: hex("k-msg") } }),
      // The person answers Paul's message although Kent finished later.
      ...turn({ trace: "p2", agent: "paul", event: id(2), replyTo: hex("p-msg"), root: ROOT, start: at(20), end: at(26) }),
    ];
    const { telemetry } = parents(spans);
    const followUp = telemetry.turns.find((t) => t.traceId === "p2")!;
    const paul = telemetry.turns.find((t) => t.traceId === "p")!;
    expect(followUp.parentTurnIndex).toBe(paul.turnIndex);
    expect(followUp.parentEdgeType).toBe("REPLY_TO");
    expect(paul.postedEventIds).toEqual([hex("p-msg")]);
  });

  it("picks no parent between agents that answered the same message together: the answer could be either's", () => {
    const spans = [
      ...turn({ trace: "p", agent: "paul", event: ROOT, start: at(0), end: at(8), posted: { text: "p", replyTo: ROOT } }),
      ...turn({ trace: "k", agent: "kent", event: ROOT, start: at(0), end: at(7), posted: { text: "k", replyTo: ROOT } }),
      ...turn({ trace: "p2", agent: "paul", event: id(2), replyTo: id("unknown-reply"), root: ROOT, start: at(20), end: at(26) }),
    ];
    const { telemetry } = parents(spans);
    const followUp = telemetry.turns.find((t) => t.traceId === "p2")!;
    const kent = telemetry.turns.find((t) => t.traceId === "k")!;
    const paul = telemetry.turns.find((t) => t.traceId === "p")!;
    expect(followUp.parentEdgeType).toBe("AMBIGUOUS");
    expect(followUp.parentTurnIndex).toBeNull();
    expect(followUp.parentCandidates).toEqual([paul.turnIndex, kent.turnIndex].sort());
    const ambiguous = telemetry.anomalies.find((a) => a.type === "AMBIGUOUS_PARENT");
    expect(ambiguous?.turnIndex).toBe(followUp.turnIndex);
    expect(ambiguous?.severity).toBe("INFO");
  });

  it("prefers the same agent's turn when a person answers a message that started several agents", () => {
    const spans = [
      ...turn({ trace: "p", agent: "paul", event: ROOT, start: at(0), end: at(8) }),
      ...turn({ trace: "k", agent: "kent", event: ROOT, start: at(0), end: at(9) }),
      ...turn({ trace: "p2", agent: "paul", event: id(2), replyTo: ROOT, root: ROOT, start: at(20), end: at(26) }),
    ];
    const { telemetry } = parents(spans);
    const followUp = telemetry.turns.find((t) => t.traceId === "p2")!;
    expect(followUp.parentTurnIndex).toBe(telemetry.turns.find((t) => t.traceId === "p")!.turnIndex);
  });

  it("never makes two overlapping turns each other's parent when both answer events no turn started from", () => {
    const spans = [
      ...turn({ trace: "t0", agent: "kent", event: ROOT, start: at(-20), end: at(-10), posted: { text: "first", replyTo: ROOT } }),
      // Two follow-ups start half a second apart and each ends after the other started.
      ...turn({ trace: "ta", agent: "paul", event: id(5), replyTo: id("x"), root: ROOT, start: at(0), end: at(1), posted: { text: "a", replyTo: id(5) } }),
      ...turn({ trace: "tb", agent: "ann", event: id(6), replyTo: id("y"), root: ROOT, start: at(0.5), end: at(1.5), posted: { text: "b", replyTo: id(6) } }),
    ];
    const { telemetry } = parents(spans);
    // Every parent comes before its child in the order (a cycle would put one after the other), and the turn that
    // started first is not the child of the one that started later.
    for (const t of telemetry.turns) {
      if (t.parentTurnIndex) {
        expect(t.parentTurnIndex).toBeLessThan(t.turnIndex);
      }
    }
    const a = telemetry.turns.find((t) => t.traceId === "ta")!;
    const b = telemetry.turns.find((t) => t.traceId === "tb")!;
    expect(a.parentTurnIndex).not.toBe(b.turnIndex);
    expect(telemetry.turns.map((t) => t.traceId)).toEqual(["t0", "ta", "tb"]);
  });

  it("reads what an agent posted through a shell command, also when the command arrives as JSON", () => {
    const shell = (trace: string, input: Record<string, string>, extra: Record<string, unknown> = {}) =>
      new SpanNode({
        span_id: `${trace}-shell`,
        trace_id: trace,
        parent_id: `${trace}-root`,
        name: "tool:run_command",
        span_kind: "TOOL",
        start_time: at(2),
        end_time: at(3),
        status_code: "OK",
        attributes: { "tool.name": "run_command", "input.value": JSON.stringify(input), ...extra },
      });
    const command = 'buzz messages send --channel "c1" --reply-to "r1" --content "@Elio I tried it, and \\"quoted\\" works"';
    const spans = [...turn({ trace: "t1", agent: "phoenix-twin", event: ROOT, start: at(0), end: at(5) }), shell("t1", { CommandLine: command })];
    const { telemetry } = parents(spans);
    expect(telemetry.turns[0].postedTexts).toEqual(['@Elio I tried it, and "quoted" works']);
    expect(telemetry.turns[0].responsePreview).toBe('@Elio I tried it, and "quoted" works');
  });

  it("still reads the start of a post when telemetry cut the command short", () => {
    const cut = 'buzz messages send --channel "c1" --reply-to "r1" --content "@Elio I attempted the read.\\n- **Result:** denied\\n- **Root Cause:*…';
    const spans = [
      ...turn({ trace: "t1", agent: "phoenix-twin", event: ROOT, start: at(0), end: at(5) }),
      new SpanNode({
        span_id: "t1-shell",
        trace_id: "t1",
        parent_id: "t1-root",
        name: "tool:run_command",
        span_kind: "TOOL",
        start_time: at(2),
        end_time: at(3),
        status_code: "OK",
        attributes: { "tool.name": "run_command", "input.value": JSON.stringify({ CommandLine: cut }) },
      }),
    ];
    const { telemetry } = parents(spans);
    expect(telemetry.turns[0].postedTexts?.[0]).toMatch(/^@Elio I attempted the read\./);
    expect(telemetry.turns[0].postedTexts?.[0]).not.toContain("…");
  });

  it("does not take a command that only reads the thread, or sends from stdin, for a post", () => {
    const shell = (cmd: string) =>
      new SpanNode({
        span_id: "t1-shell",
        trace_id: "t1",
        parent_id: "t1-root",
        name: "tool:run_command",
        span_kind: "TOOL",
        start_time: at(2),
        end_time: at(3),
        status_code: "OK",
        attributes: { "tool.name": "run_command", "input.value": JSON.stringify({ CommandLine: cmd }) },
      });
    for (const cmd of ['buzz messages thread --channel "c" --event r', 'buzz messages send --channel "c" --content -', "ls -la"]) {
      const { telemetry } = parents([...turn({ trace: "t1", agent: "a", event: ROOT, start: at(0), end: at(5) }), shell(cmd)]);
      expect(telemetry.turns[0].postedTexts).toEqual([]);
    }
  });

  it("previews what the person asked and what the agent posted, not the envelope or the model's aside", () => {
    const spans = turn({
      trace: "t1",
      agent: "paul",
      event: ROOT,
      start: at(0),
      end: at(5),
      content: "@Paul Twin What problem does SimpleMDG solve?",
      posted: { text: "SimpleMDG gives SAP MDG customers a governed request flow.", replyTo: ROOT },
    });
    const { telemetry } = parents(spans);
    const t = telemetry.turns[0];
    expect(t.promptPreview).toBe("@Paul Twin What problem does SimpleMDG solve?");
    expect(t.responsePreview).toBe("SimpleMDG gives SAP MDG customers a governed request flow.");
    expect(t.postedTexts).toEqual(["SimpleMDG gives SAP MDG customers a governed request flow."]);
    expect(t.senderName).toBe("Elio Tran");
  });
});
