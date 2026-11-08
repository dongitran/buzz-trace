/**
 * A turn's `llm.token_count.prompt` is summed over every model call of the turn (each tool step is one more call that
 * re-reads the whole context). The size of the context itself is that sum divided by the number of calls, and the
 * number of calls is one more than the number of tool steps: tools that run together are one step. Checked on real
 * ba twin turns: the harness's own count of calls (its uncached input, two tokens a call) matched on 15 of 15.
 */
import { describe, expect, it } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { AnomalyDetector } from "../src/engine/analyzer.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { TerminalRenderer } from "../src/formatters/terminal.js";
import { SpanNode, ThreadTelemetry } from "../src/models.js";

const ROOT = "a".repeat(64);
const id = (n: number) => String(n).padStart(64, "d");
const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 1, 0, 0) + s * 1000).toISOString();

interface Tool {
  name: string;
  from: number;
  to: number;
}

function turn(o: { n: number; agent: string; start: number; end: number; prompt: number; tools: Tool[]; replyTo?: string }): SpanNode[] {
  const trace = `t${o.n}`;
  return [
    new SpanNode({
      span_id: `${trace}-root`,
      trace_id: trace,
      parent_id: null,
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: at(o.start),
      end_time: at(o.end),
      status_code: "OK",
      attributes: {
        "session.id": ROOT,
        "agent.name": o.agent,
        "nostr.event_id": o.n === 1 ? ROOT : id(o.n),
        "nostr.thread_root_id": ROOT,
        ...(o.replyTo ? { "nostr.reply_to_id": o.replyTo } : {}),
      },
    }),
    new SpanNode({
      span_id: `${trace}-llm`,
      trace_id: trace,
      parent_id: `${trace}-root`,
      name: "llm:sonnet",
      span_kind: "LLM",
      start_time: at(o.start),
      end_time: at(o.end),
      status_code: "OK",
      attributes: {
        "llm.model_name": "sonnet",
        "llm.token_count.prompt": o.prompt,
        "llm.token_count.completion": 300,
        "llm.token_count.total": o.prompt + 300,
      },
    }),
    ...o.tools.map(
      (tool, i) =>
        new SpanNode({
          span_id: `${trace}-tool${i}`,
          trace_id: trace,
          parent_id: `${trace}-root`,
          name: `tool:${tool.name}`,
          span_kind: "TOOL",
          start_time: at(tool.from),
          end_time: at(tool.to),
          status_code: "OK",
          attributes: { "tool.name": tool.name },
        }),
    ),
  ];
}

const reply = (from: number): Tool => ({ name: "mcp__buzz-thread__reply", from, to: from + 1 });
const search = (from: number): Tool => ({ name: "mcp__knowledge__knowledge_search", from, to: from + 0.6 });
const read = (from: number): Tool => ({ name: "mcp__buzz-thread__thread_read", from, to: from + 0.8 });

function aggregate(spans: SpanNode[]) {
  return new ThreadAggregator(ROOT, "ba").aggregate(spans);
}

describe("model calls and context per call of a turn", () => {
  it("counts one call when a turn used no tool, and one more for every step of tools", () => {
    const t = aggregate([
      ...turn({ n: 1, agent: "a", start: 0, end: 5, prompt: 20000, tools: [] }),
      ...turn({ n: 2, agent: "b", start: 10, end: 20, prompt: 69000, tools: [search(11), reply(14)], replyTo: ROOT }),
    ]);
    expect(t.turns.map((x) => x.modelCalls)).toEqual([1, 3]);
    expect(t.turns.map((x) => x.contextPerCall)).toEqual([20000, 23000]);
  });

  it("counts tools that run together as one step", () => {
    const t = aggregate(turn({ n: 1, agent: "a", start: 0, end: 12, prompt: 120000, tools: [read(1), search(1.05), reply(5)] }));
    expect(t.turns[0].modelCalls).toBe(3);
    expect(t.turns[0].contextPerCall).toBe(40000);
  });

  it("says nothing about context when the turn reported no prompt tokens", () => {
    const t = aggregate(turn({ n: 1, agent: "a", start: 0, end: 5, prompt: 0, tools: [reply(2)] }));
    expect(t.turns[0].contextPerCall).toBeUndefined();
  });
});

describe("anomalies judged on the context of one call", () => {
  const turnOf = (turnIndex: number, agent: string, promptTokens: number, modelCalls: number) => ({
    turnIndex,
    traceId: `tr-${turnIndex}`,
    agentName: agent,
    modelName: "sonnet",
    durationMs: 8000,
    promptTokens,
    completionTokens: 300,
    reasoningTokens: 0,
    totalTokens: promptTokens + 300,
    modelCalls,
    contextPerCall: Math.round(promptTokens / modelCalls),
    statusCode: "OK",
    statusMessage: null,
    promptPreview: "",
    responsePreview: "",
    tools: [],
    spans: [],
  });
  const of = (...turns: ReturnType<typeof turnOf>[]) => new ThreadTelemetry({ threadId: "th", turns });
  const types = (t: ThreadTelemetry) => new AnomalyDetector().analyze(t).map((a) => a.type);

  it("does not call 170k tokens summed over three calls a bloated context", () => {
    expect(types(of(turnOf(1, "paul", 170000, 3)))).not.toContain("TOKEN_BLOAT");
  });

  it("still calls a single 200k-token context bloated", () => {
    const bloat = new AnomalyDetector().analyze(of(turnOf(1, "paul", 200000, 1))).find((a) => a.type === "TOKEN_BLOAT");
    expect(bloat?.message).toContain("200,000");
  });

  it("does not read a turn with more calls than the last one as token inflation", () => {
    // 2 calls of ~23k, then 3 calls of ~38k: the sums differ 2.5x, the contexts 1.7x.
    expect(types(of(turnOf(1, "paul", 45536, 2), turnOf(2, "paul", 114606, 3)))).not.toContain("TOKEN_INFLATION");
  });

  it("flags an agent whose context per call keeps growing round after round", () => {
    // Paul in a thread session: ~23k, ~40k, ~57k, ~72k per call (what a repeated static prompt block does).
    const t = of(turnOf(1, "paul", 69177, 3), turnOf(2, "paul", 120412, 3), turnOf(3, "paul", 170112, 3), turnOf(4, "paul", 144581, 2));
    const growth = new AnomalyDetector().analyze(t).filter((a) => a.type === "CONTEXT_GROWTH");
    expect(growth).toHaveLength(1);
    expect(growth[0].turnIndex).toBe(4);
    expect(growth[0].severity).toBe("WARNING");
    expect(growth[0].details).toMatchObject({ agent: "paul", firstTurn: 1, lastTurn: 4, firstContext: 23059, lastContext: 72291 });
    expect(growth[0].message).toMatch(/23,059.*72,291/);
  });

  it("does not flag two turns, a flat context, or two agents each with little growth", () => {
    expect(types(of(turnOf(1, "paul", 69000, 3), turnOf(2, "paul", 120000, 3)))).not.toContain("CONTEXT_GROWTH");
    expect(types(of(turnOf(1, "kent", 69000, 3), turnOf(2, "kent", 70000, 3), turnOf(3, "kent", 71000, 3)))).not.toContain("CONTEXT_GROWTH");
    expect(types(of(turnOf(1, "paul", 69000, 3), turnOf(2, "kent", 69000, 3), turnOf(3, "paul", 80000, 3), turnOf(4, "kent", 80000, 3)))).not.toContain(
      "CONTEXT_GROWTH",
    );
  });
});

describe("how the context of a call is shown", () => {
  const thread = aggregate([
    ...turn({ n: 1, agent: "paul", start: 0, end: 12, prompt: 69177, tools: [search(2), reply(8)] }),
    ...turn({ n: 2, agent: "paul", start: 20, end: 30, prompt: 144581, tools: [reply(24)], replyTo: ROOT }),
  ]);

  it("full JSON carries model_calls and context_per_call for every turn", () => {
    const turns = thread.toJSON().turns;
    expect(turns.map((t) => [t.model_calls, t.context_per_call])).toEqual([
      [3, 23059],
      [2, 72291],
    ]);
  });

  it("compact JSON adds calls and ctx only to a turn that made more than one call", () => {
    const compact = JSON.parse(new JsonRenderer().render(thread, { compact: true, flat: true }));
    expect(compact.turns[0]).toMatchObject({ calls: 3, ctx: 23059 });
    const solo = aggregate(turn({ n: 1, agent: "a", start: 0, end: 5, prompt: 20000, tools: [] }));
    const soloCompact = JSON.parse(new JsonRenderer().render(solo, { compact: true, flat: true }));
    expect(soloCompact.turns[0].calls).toBeUndefined();
    expect(soloCompact.turns[0].ctx).toBeUndefined();
  });

  it("the terminal report says the context is an estimate", () => {
    const out = new TerminalRenderer(false).render(thread);
    expect(out).toContain("Context  : ~23,059 per call × ~3 calls");
  });
});
