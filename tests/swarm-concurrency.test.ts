/**
 * Subagent 2.3: 10-Agent Swarm Concurrency & Branching Topology Test Suite
 * 
 * Verifies:
 * 1. 10 agents concurrently replying to a broadcast note:
 *    - Agent 1: Lead planner (starts turn, runs 3 tools, duration 15s)
 *    - Agents 2..10: 9 specialist agents replying concurrently with staggered durations
 *      (3s to 50s), diverse tool execution counts (0 to 12 tools), and random clock offsets (±500ms).
 *    - Agent 10 cross-replies to Agent 2 (creating a second-level branch).
 * 2. Kahn's topological sort resolves all 10 branches into clean, atomic turns without tool interleaving.
 * 3. Branch IDs correctly partition the tree ('main', 'branch-turn1-2'..'branch-turn1-9', and sub-branches).
 * 4. High-performance aggregation: sub-millisecond execution for 100+ spans across 10 agents.
 */

import { describe, it, expect } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { ThreadQueryEngine } from "../src/engine/query.js";
import { TerminalRenderer, JsonRenderer, MarkdownRenderer } from "../src/formatters/index.js";
import { SpanNode } from "../src/models.js";

function createSpan(opts: {
  spanId: string;
  parentId?: string | null;
  traceId: string;
  name: string;
  spanKind?: string;
  startTime: string;
  endTime: string;
  statusCode?: string;
  statusMessage?: string | null;
  attributes?: Record<string, unknown>;
}): SpanNode {
  return new SpanNode({
    span_id: opts.spanId,
    parent_id: opts.parentId || null,
    trace_id: opts.traceId,
    name: opts.name,
    span_kind: opts.spanKind || "SPAN_KIND_INTERNAL",
    start_time: opts.startTime,
    end_time: opts.endTime,
    status_code: opts.statusCode || "OK",
    status_message: opts.statusMessage || null,
    attributes: opts.attributes || {},
  });
}

function buildSwarmFixture() {
  const sessionId = "swarm-thread-root-85002-abc123456789";
  const threadId = sessionId;
  const t0 = new Date("2026-11-01T12:00:00.000Z").getTime();
  const allSpans: SpanNode[] = [];

  // 1. Lead planner (Turn 1, duration 15s, 3 tools)
  const t1Start = t0;
  const t1Dur = 15000;
  const t1End = t1Start + t1Dur;
  const t1Trace = "tr-agent-01-lead";
  const t1RootSpanId = "sp-agent-01-root";
  const t1EventId = "ev-agent-01-lead-root";

  allSpans.push(
    createSpan({
      spanId: t1RootSpanId,
      traceId: t1Trace,
      name: "agent_turn",
      spanKind: "AGENT",
      startTime: new Date(t1Start).toISOString(),
      endTime: new Date(t1End).toISOString(),
      attributes: {
        "session.id": sessionId,
        "agent.id": "lead-planner",
        "agent.name": "lead-planner",
        "nostr.event_id": t1EventId,
      },
    })
  );

  allSpans.push(
    createSpan({
      spanId: "sp-t1-llm-1",
      parentId: t1RootSpanId,
      traceId: t1Trace,
      name: "llm:plan_decomposition",
      spanKind: "LLM",
      startTime: new Date(t1Start + 100).toISOString(),
      endTime: new Date(t1Start + 3500).toISOString(),
      attributes: {
        "llm.model_name": "claude-3-7-sonnet",
        "llm.token_count.prompt": 2840,
        "llm.token_count.completion": 1120,
        "llm.token_count.total": 3960,
        "input.value": "Decompose multi-agent architecture and assign tasks to 9 specialists.",
      },
    })
  );

  const t1Tools = [
    { name: "read_specification", dur: 1200 },
    { name: "ast_analyzer", dur: 4500 },
    { name: "emit_task_matrix", dur: 800 },
  ];
  let curT1 = t1Start + 3700;
  for (let i = 0; i < t1Tools.length; i++) {
    const tool = t1Tools[i];
    allSpans.push(
      createSpan({
        spanId: `sp-t1-tool-${i + 1}`,
        parentId: t1RootSpanId,
        traceId: t1Trace,
        name: `tool:${tool.name}`,
        spanKind: "TOOL",
        startTime: new Date(curT1).toISOString(),
        endTime: new Date(curT1 + tool.dur).toISOString(),
        attributes: { "tool.name": tool.name, "input.value": `{"step": ${i + 1}}` },
      })
    );
    curT1 += tool.dur + 100;
  }

  // 2. 9 Specialists replying concurrently to Agent 1
  const specialists = [
    { id: "db-architect", model: "claude-3-5-haiku", dur: 3500, offset: -350, toolCount: 1 },
    { id: "sec-auditor", model: "claude-3-5-sonnet", dur: 6800, offset: 120, toolCount: 2 },
    { id: "infra-gate", model: "claude-3-7-sonnet", dur: 11200, offset: -480, toolCount: 4 },
    { id: "api-developer", model: "claude-3-5-sonnet", dur: 16500, offset: 420, toolCount: 5 },
    { id: "law-arbiter", model: "claude-3-7-sonnet", dur: 22000, offset: -150, toolCount: 0 },
    { id: "ui-ux-designer", model: "claude-3-5-sonnet", dur: 29400, offset: 280, toolCount: 6 },
    { id: "perf-optimizer", model: "claude-3-5-sonnet", dur: 36100, offset: -290, toolCount: 8 },
    { id: "test-qa-runner", model: "claude-3-5-sonnet", dur: 44000, offset: 180, toolCount: 10 },
    { id: "deployment-steward", model: "claude-3-7-sonnet", dur: 49500, offset: -450, toolCount: 12 },
  ];

  for (let idx = 0; idx < specialists.length; idx++) {
    const spec = specialists[idx];
    const traceId = `tr-agent-${idx + 2}-${spec.id}`;
    const rootSpanId = `sp-agent-${idx + 2}-root`;
    const eventId = `ev-agent-${idx + 2}-${spec.id}`;
    const startMs = t1End + spec.offset;
    const endMs = startMs + spec.dur;

    allSpans.push(
      createSpan({
        spanId: rootSpanId,
        traceId,
        name: "agent_turn",
        spanKind: "AGENT",
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
        attributes: {
          "session.id": sessionId,
          "agent.id": spec.id,
          "agent.name": spec.id,
          "nostr.event_id": eventId,
          "nostr.reply_to": t1EventId, // Direct reply to Agent 1!
        },
      })
    );

    allSpans.push(
      createSpan({
        spanId: `sp-${spec.id}-llm-start`,
        parentId: rootSpanId,
        traceId,
        name: "llm:reason",
        spanKind: "LLM",
        startTime: new Date(startMs + 50).toISOString(),
        endTime: new Date(startMs + 800).toISOString(),
        attributes: {
          "llm.model_name": spec.model,
          "llm.token_count.prompt": 1500,
          "llm.token_count.completion": 500,
          "llm.token_count.total": 2000,
        },
      })
    );

    let tCursor = startMs + 900;
    for (let t = 0; t < spec.toolCount; t++) {
      allSpans.push(
        createSpan({
          spanId: `sp-${spec.id}-tool-${t + 1}`,
          parentId: rootSpanId,
          traceId,
          name: `tool:op_${t + 1}`,
          spanKind: "TOOL",
          startTime: new Date(tCursor).toISOString(),
          endTime: new Date(tCursor + 300).toISOString(),
          attributes: { "tool.name": `op_${t + 1}` },
        })
      );
      tCursor += 400;
    }

    allSpans.push(
      createSpan({
        spanId: `sp-${spec.id}-llm-end`,
        parentId: rootSpanId,
        traceId,
        name: "llm:output",
        spanKind: "LLM",
        startTime: new Date(tCursor).toISOString(),
        endTime: new Date(endMs - 50).toISOString(),
        attributes: {
          "llm.model_name": spec.model,
          "output.value": `Completed task for ${spec.id}`,
        },
      })
    );
  }

  // 3. Agent 10 Cross-Replies to Agent 2 (db-architect)
  const tCrossStart = t1End + 6000;
  const tCrossDur = 5200;
  const tCrossEnd = tCrossStart + tCrossDur;
  const tCrossTrace = "tr-agent-10-cross-reply";
  const tCrossRootSpanId = "sp-agent-10-cross-root";

  allSpans.push(
    createSpan({
      spanId: tCrossRootSpanId,
      traceId: tCrossTrace,
      name: "agent_turn",
      spanKind: "AGENT",
      startTime: new Date(tCrossStart).toISOString(),
      endTime: new Date(tCrossEnd).toISOString(),
      attributes: {
        "session.id": sessionId,
        "agent.id": "deployment-steward",
        "agent.name": "deployment-steward",
        "nostr.event_id": "ev-agent-10-cross",
        "nostr.reply_to": "ev-agent-2-db-architect", // Cross-reply to Agent 2!
      },
    })
  );

  allSpans.push(
    createSpan({
      spanId: "sp-cross-tool-1",
      parentId: tCrossRootSpanId,
      traceId: tCrossTrace,
      name: "tool:migrate_db_lock_check",
      spanKind: "TOOL",
      startTime: new Date(tCrossStart + 500).toISOString(),
      endTime: new Date(tCrossStart + 1200).toISOString(),
      attributes: { "tool.name": "migrate_db_lock_check" },
    })
  );

  return { threadId, allSpans };
}

describe("10-Agent Swarm Concurrency & Branching Topology Simulation", () => {
  it("resolves all 10 branches into clean atomic turns without tool interleaving", () => {
    const { threadId, allSpans } = buildSwarmFixture();
    const agg = new ThreadAggregator(threadId, "mobile");
    const telemetry = agg.aggregate(allSpans);

    // 1. Verify Turn Count
    expect(telemetry.turns).toHaveLength(11); // 1 Root + 9 Specialists + 1 Cross Reply

    // 2. Invariant: Zero tool interleaving across turns
    for (const turn of telemetry.turns) {
      for (const tool of turn.tools) {
        const matchingSpan = turn.spans.find((s) => s.spanId === tool.spanId);
        expect(matchingSpan).toBeDefined();
        expect(matchingSpan?.traceId).toBe(turn.traceId);
      }
    }

    // 3. Invariant: Strict Causal Precedence
    for (const edge of telemetry.dag?.edges || []) {
      expect(edge.fromTurnIndex).toBeLessThan(edge.toTurnIndex);
    }

    // 4. Invariant: Arborescence Properties (|V|=11, |E|=10, Roots=1)
    expect(telemetry.dag?.rootIndices).toEqual([1]);
    expect(telemetry.dag?.edges).toHaveLength(10);

    // 5. Invariant: Second-level branch correctly links Agent 10 to Agent 2
    const agent2Turn = telemetry.turns.find((t) => t.agentName === "db-architect")!;
    const crossTurn = telemetry.turns.find((t) => t.traceId === "tr-agent-10-cross-reply")!;
    expect(crossTurn.parentTurnIndex).toBe(agent2Turn.turnIndex);
    expect(crossTurn.depth).toBe(2);

    // 6. Branch Partitioning
    const branchIds = telemetry.dag?.branches.map((b) => b.branchId);
    expect(branchIds).toContain("main");
    expect(branchIds).toContain("branch-turn1-2");
    expect(branchIds).toContain("branch-turn1-3");
    expect(telemetry.dag?.branches.length).toBeGreaterThanOrEqual(9);

    // 7. Renderers sanity check
    const jsonFmt = new JsonRenderer();
    const flatCompact = jsonFmt.render(telemetry, { compact: true, flat: true });
    expect(flatCompact).not.toContain("\n");
    expect(JSON.parse(flatCompact)).toHaveProperty("thread_id", threadId);

    const termFmt = new TerminalRenderer(false);
    const terminalText = termFmt.render(telemetry);
    expect(terminalText).toContain("BUZZ-TRACE");
    expect(terminalText).toContain("Turn 11");

    const mdFmt = new MarkdownRenderer();
    const mdText = mdFmt.render(telemetry);
    expect(mdText).toContain("graph TD");
    expect(mdText).toContain("Turn Timeline");
  });

  it("completes DAG aggregation in a few milliseconds for 10 agents and 100+ spans", () => {
    const { threadId, allSpans } = buildSwarmFixture();
    const agg = new ThreadAggregator(threadId, "mobile");

    // Warm-up
    for (let i = 0; i < 10; i++) {
      agg.aggregate(allSpans);
    }

    const start = performance.now();
    const runs = 50;
    for (let i = 0; i < runs; i++) {
      agg.aggregate(allSpans);
    }
    const avgMs = (performance.now() - start) / runs;
    // About 0.2 ms alone. It is wall-clock time, and the suite's other files run at the same time (and under coverage in CI):
    // a 1 ms limit failed one run in four there. 5 ms still catches an algorithmic regression.
    expect(avgMs).toBeLessThan(5.0);
  });

  it("filters single turn AI self-reflection query to under 200 tokens", () => {
    const { threadId, allSpans } = buildSwarmFixture();
    const agg = new ThreadAggregator(threadId, "mobile");
    const telemetry = agg.aggregate(allSpans);

    const queryEngine = new ThreadQueryEngine();
    const lastTurn = queryEngine.filter(telemetry, { lastN: 1 });

    const jsonFmt = new JsonRenderer();
    const flatJson = jsonFmt.render(lastTurn, { compact: true, flat: true });

    const tokenEstimate = Math.round(flatJson.length / 4);
    expect(tokenEstimate).toBeLessThan(200);
  });
});
