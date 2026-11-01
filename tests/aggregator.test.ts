import { describe, it, expect } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { SpanNode } from "../src/models.js";

describe("ThreadAggregator", () => {
  it("should aggregate multiple turns chronologically", () => {
    const spans = [
      // Turn 1
      new SpanNode({
        span_id: "s1",
        trace_id: "t1",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T06:11:10.000Z",
        end_time: "2026-11-01T06:11:20.000Z",
        status_code: "OK",
        attributes: { "session.id": "thread-123", "agent.name": "phoenix-twin" },
      }),
      new SpanNode({
        span_id: "s2",
        trace_id: "t1",
        name: "llm:gemini-3.8-flash-high",
        span_kind: "LLM",
        parent_id: "s1",
        attributes: {
          "llm.model_name": "gemini-3.8-flash-high",
          "llm.token_count.prompt": 1000,
          "llm.token_count.completion": 150,
          "llm.token_count.total": 1150,
        },
      }),
      // Turn 2
      new SpanNode({
        span_id: "s3",
        trace_id: "t2",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T06:12:00.000Z",
        end_time: "2026-11-01T06:12:15.000Z",
        status_code: "OK",
        attributes: { "session.id": "thread-123", "agent.name": "paul-twin" },
      }),
      new SpanNode({
        span_id: "s4",
        trace_id: "t2",
        name: "tool:run_command",
        span_kind: "TOOL",
        parent_id: "s3",
        attributes: { "tool.name": "run_command", "input.value": "echo hello", "tool.output_bytes": 10 },
      }),
      new SpanNode({
        span_id: "s5",
        trace_id: "t2",
        name: "llm:gemini-3.8-flash-high",
        span_kind: "LLM",
        parent_id: "s3",
        attributes: {
          "llm.model_name": "gemini-3.8-flash-high",
          "llm.token_count.prompt": 2000,
          "llm.token_count.completion": 300,
          "llm.token_count.total": 2300,
        },
      }),
    ];

    const aggregator = new ThreadAggregator("thread-123", "mobile");
    const telemetry = aggregator.aggregate(spans);

    expect(telemetry.threadId).toBe("thread-123");
    expect(telemetry.totalTurns).toBe(2);
    expect(telemetry.totalTokens).toBe(3450);
    expect(telemetry.totalPromptTokens).toBe(3000);
    expect(telemetry.totalCompletionTokens).toBe(450);
    expect(telemetry.status).toBe("OK");

    // Turn 1 assertions
    expect(telemetry.turns[0].turnIndex).toBe(1);
    expect(telemetry.turns[0].agentName).toBe("phoenix-twin");
    expect(telemetry.turns[0].totalTokens).toBe(1150);
    expect(telemetry.turns[0].tools).toHaveLength(0);

    // Turn 2 assertions
    expect(telemetry.turns[1].turnIndex).toBe(2);
    expect(telemetry.turns[1].agentName).toBe("paul-twin");
    expect(telemetry.turns[1].totalTokens).toBe(2300);
    expect(telemetry.turns[1].tools).toHaveLength(1);
    expect(telemetry.turns[1].tools[0].name).toBe("run_command");
  });

  it("should handle empty spans gracefully", () => {
    const aggregator = new ThreadAggregator("empty-thread", "mobile");
    const telemetry = aggregator.aggregate([]);
    expect(telemetry.status).toBe("NOT_FOUND");
    expect(telemetry.totalTurns).toBe(0);
  });

  it("should resolve causal turn ordering and detect clock skew when Turn 2 timestamp is earlier than Turn 1", () => {
    // Scenario:
    // Host A (phoenix-twin) starts at 10:00:00.200Z, produces event ev-1
    // Host B (coder-agent) has 150ms negative clock skew, starts at 10:00:00.050Z, replies to ev-1
    const spans = [
      new SpanNode({
        span_id: "s-turn1",
        trace_id: "trace-1",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:00.200Z",
        end_time: "2026-11-01T10:00:01.000Z",
        status_code: "OK",
        attributes: {
          "session.id": "thread-skew",
          "agent.name": "phoenix-twin",
          "nostr.event_id": "ev-1",
        },
      }),
      new SpanNode({
        span_id: "s-turn2",
        trace_id: "trace-2",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:00.050Z", // Clock skew: 150ms earlier than Turn 1!
        end_time: "2026-11-01T10:00:01.500Z",
        status_code: "OK",
        attributes: {
          "session.id": "thread-skew",
          "agent.name": "coder-agent",
          "nostr.event_id": "ev-2",
          "nostr.reply_to": "ev-1",
        },
      }),
    ];

    const aggregator = new ThreadAggregator("thread-skew", "mobile");
    const telemetry = aggregator.aggregate(spans);

    // Turn 1 must precede Turn 2 despite Turn 2 having an earlier raw timestamp
    expect(telemetry.turns).toHaveLength(2);
    expect(telemetry.turns[0].agentName).toBe("phoenix-twin");
    expect(telemetry.turns[0].turnIndex).toBe(1);
    expect(telemetry.turns[1].agentName).toBe("coder-agent");
    expect(telemetry.turns[1].turnIndex).toBe(2);
    expect(telemetry.turns[1].parentTurnIndex).toBe(1);

    // A CLOCK_SKEW anomaly must be detected
    const skewAnomaly = telemetry.anomalies.find((a) => a.type === "CLOCK_SKEW");
    expect(skewAnomaly).toBeDefined();
    expect(skewAnomaly?.severity).toBe("WARNING");
    expect(skewAnomaly?.turnIndex).toBe(2);
    expect(skewAnomaly?.details?.skewMs).toBe(150);
  });

  it("should construct multi-agent branching DAG when multiple agents reply to the same turn", () => {
    // Scenario:
    // Turn 1: phoenix-twin (ev-root)
    // Turn 2: coder-agent (ev-coder, replies to ev-root)
    // Turn 3: planner-agent (ev-planner, replies to ev-root) -> Branch fork!
    // Turn 4: reviewer-agent (ev-reviewer, replies to ev-coder) -> Follows coder
    const spans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "t1",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:00.000Z",
        attributes: { "agent.name": "phoenix-twin", "nostr.event_id": "ev-root" },
      }),
      new SpanNode({
        span_id: "s2",
        trace_id: "t2",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:01.000Z",
        attributes: { "agent.name": "coder-agent", "nostr.event_id": "ev-coder", "nostr.reply_to": "ev-root" },
      }),
      new SpanNode({
        span_id: "s3",
        trace_id: "t3",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:02.000Z",
        attributes: { "agent.name": "planner-agent", "nostr.event_id": "ev-planner", "nostr.reply_to": "ev-root" },
      }),
      new SpanNode({
        span_id: "s4",
        trace_id: "t4",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:03.000Z",
        attributes: { "agent.name": "reviewer-agent", "nostr.event_id": "ev-reviewer", "nostr.reply_to": "ev-coder" },
      }),
    ];

    const aggregator = new ThreadAggregator("thread-branch", "mobile");
    const telemetry = aggregator.aggregate(spans);

    expect(telemetry.turns).toHaveLength(4);
    expect(telemetry.dag).toBeDefined();
    expect(telemetry.dag?.rootIndices).toEqual([1]);

    // Check parent links
    expect(telemetry.turns[0].parentTurnIndex).toBeNull();
    expect(telemetry.turns[1].parentTurnIndex).toBe(1); // coder replied to root
    expect(telemetry.turns[2].parentTurnIndex).toBe(1); // planner replied to root
    expect(telemetry.turns[3].parentTurnIndex).toBe(2); // reviewer replied to coder

    // Check depths
    expect(telemetry.turns[0].depth).toBe(0);
    expect(telemetry.turns[1].depth).toBe(1);
    expect(telemetry.turns[2].depth).toBe(1);
    expect(telemetry.turns[3].depth).toBe(2);

    // Check branching
    expect(telemetry.turns[0].childrenTurnIndices).toEqual([2, 3]);
    expect(telemetry.turns[1].childrenTurnIndices).toEqual([4]);

    // Check DAG edges
    expect(telemetry.dag?.edges).toHaveLength(3);
    expect(telemetry.dag?.edges).toContainEqual({ fromTurnIndex: 1, toTurnIndex: 2, type: "REPLY_TO" });
    expect(telemetry.dag?.edges).toContainEqual({ fromTurnIndex: 1, toTurnIndex: 3, type: "REPLY_TO" });
    expect(telemetry.dag?.edges).toContainEqual({ fromTurnIndex: 2, toTurnIndex: 4, type: "REPLY_TO" });
  });

  it("should handle complex 10-agent multi-branching DAG with multiple parallel tracks", () => {
    // 10-agent team scenario:
    // Turn 1: user-prompt (ev-1)
    // Turn 2: agent-lead (ev-2, replies to ev-1)
    // Turn 3: architect (ev-3, replies to ev-2)
    // Turn 4: db-agent (ev-4, replies to ev-3) -> Child 1 of Turn 3 (main branch)
    // Turn 5: backend-agent (ev-5, replies to ev-3) -> Child 2 of Turn 3 (branch-turn3-2)
    // Turn 6: frontend-agent (ev-6, replies to ev-3) -> Child 3 of Turn 3 (branch-turn3-3)
    // Turn 7: security-reviewer (ev-7, replies to ev-5) -> Follows backend-agent
    // Turn 8: qa-agent (ev-8, replies to ev-6) -> Follows frontend-agent
    // Turn 9: infra-gate (ev-9, replies to ev-7) -> Follows security-reviewer
    // Turn 10: publisher (ev-10, replies to ev-9) -> Follows infra-gate
    const spans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "tr-1",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:00.000Z",
        attributes: { "agent.name": "user-prompt", "nostr.event_id": "ev-1" },
      }),
      new SpanNode({
        span_id: "s2",
        trace_id: "tr-2",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:05.000Z",
        attributes: { "agent.name": "agent-lead", "nostr.event_id": "ev-2", "nostr.reply_to": "ev-1" },
      }),
      new SpanNode({
        span_id: "s3",
        trace_id: "tr-3",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:10.000Z",
        attributes: { "agent.name": "architect", "nostr.event_id": "ev-3", "nostr.reply_to": "ev-2" },
      }),
      new SpanNode({
        span_id: "s4",
        trace_id: "tr-4",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:15.000Z",
        attributes: { "agent.name": "db-agent", "nostr.event_id": "ev-4", "nostr.reply_to": "ev-3" },
      }),
      new SpanNode({
        span_id: "s5",
        trace_id: "tr-5",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:16.000Z",
        attributes: { "agent.name": "backend-agent", "nostr.event_id": "ev-5", "nostr.reply_to": "ev-3" },
      }),
      new SpanNode({
        span_id: "s6",
        trace_id: "tr-6",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:17.000Z",
        attributes: { "agent.name": "frontend-agent", "nostr.event_id": "ev-6", "nostr.reply_to": "ev-3" },
      }),
      new SpanNode({
        span_id: "s7",
        trace_id: "tr-7",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:20.000Z",
        attributes: { "agent.name": "security-reviewer", "nostr.event_id": "ev-7", "nostr.reply_to": "ev-5" },
      }),
      new SpanNode({
        span_id: "s8",
        trace_id: "tr-8",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:22.000Z",
        attributes: { "agent.name": "qa-agent", "nostr.event_id": "ev-8", "nostr.reply_to": "ev-6" },
      }),
      new SpanNode({
        span_id: "s9",
        trace_id: "tr-9",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:25.000Z",
        attributes: { "agent.name": "infra-gate", "nostr.event_id": "ev-9", "nostr.reply_to": "ev-7" },
      }),
      new SpanNode({
        span_id: "s10",
        trace_id: "tr-10",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T12:00:30.000Z",
        attributes: { "agent.name": "publisher", "nostr.event_id": "ev-10", "nostr.reply_to": "ev-9" },
      }),
    ];

    const aggregator = new ThreadAggregator("thread-10-agent", "mobile");
    const telemetry = aggregator.aggregate(spans);

    expect(telemetry.turns).toHaveLength(10);
    expect(telemetry.dag?.rootIndices).toEqual([1]);

    // Check tree structure and depths
    expect(telemetry.turns[0].agentName).toBe("user-prompt");
    expect(telemetry.turns[0].depth).toBe(0);

    expect(telemetry.turns[1].agentName).toBe("agent-lead");
    expect(telemetry.turns[1].parentTurnIndex).toBe(1);
    expect(telemetry.turns[1].depth).toBe(1);

    expect(telemetry.turns[2].agentName).toBe("architect");
    expect(telemetry.turns[2].parentTurnIndex).toBe(2);
    expect(telemetry.turns[2].depth).toBe(2);

    // architect has 3 children: db-agent (4), backend-agent (5), frontend-agent (6)
    expect(telemetry.turns[2].childrenTurnIndices).toEqual([4, 5, 6]);

    // db-agent is turn 4
    expect(telemetry.turns[3].agentName).toBe("db-agent");
    expect(telemetry.turns[3].parentTurnIndex).toBe(3);
    expect(telemetry.turns[3].branchId).toBe("main");

    // backend-agent is turn 5 (first branch fork)
    expect(telemetry.turns[4].agentName).toBe("backend-agent");
    expect(telemetry.turns[4].parentTurnIndex).toBe(3);
    expect(telemetry.turns[4].branchId).toBe("branch-turn3-2");

    // frontend-agent is turn 6 (second branch fork)
    expect(telemetry.turns[5].agentName).toBe("frontend-agent");
    expect(telemetry.turns[5].parentTurnIndex).toBe(3);
    expect(telemetry.turns[5].branchId).toBe("branch-turn3-3");

    // security-reviewer is turn 7 (follows backend-agent)
    expect(telemetry.turns[6].agentName).toBe("security-reviewer");
    expect(telemetry.turns[6].parentTurnIndex).toBe(5);
    expect(telemetry.turns[6].branchId).toBe("branch-turn3-2");

    // qa-agent is turn 8 (follows frontend-agent)
    expect(telemetry.turns[7].agentName).toBe("qa-agent");
    expect(telemetry.turns[7].parentTurnIndex).toBe(6);
    expect(telemetry.turns[7].branchId).toBe("branch-turn3-3");

    // infra-gate is turn 9 (follows security-reviewer)
    expect(telemetry.turns[8].agentName).toBe("infra-gate");
    expect(telemetry.turns[8].parentTurnIndex).toBe(7);
    expect(telemetry.turns[8].branchId).toBe("branch-turn3-2");

    // publisher is turn 10 (follows infra-gate)
    expect(telemetry.turns[9].agentName).toBe("publisher");
    expect(telemetry.turns[9].parentTurnIndex).toBe(9);
    expect(telemetry.turns[9].branchId).toBe("branch-turn3-2");
    expect(telemetry.turns[9].depth).toBe(6);

    // Verify DAG edges
    expect(telemetry.dag?.edges).toHaveLength(9);
    expect(telemetry.dag?.branches).toHaveLength(3);
    const branchNames = telemetry.dag?.branches.map((b) => b.branchId);
    expect(branchNames).toContain("main");
    expect(branchNames).toContain("branch-turn3-2");
    expect(branchNames).toContain("branch-turn3-3");
  });

  it("should prevent multi-hop causal inversion and detect cumulative clock skew across distributed hosts", () => {
    // Distributed scenario with 4 hosts:
    // Host 1 (Cloud VM): starts at 10:00:01.000Z (ev-1)
    // Host 2 (NUC): -300ms skew, starts at 10:00:00.700Z (ev-2, replies to ev-1)
    // Host 3 (WSL2): -500ms skew from Host 2, starts at 10:00:00.200Z (ev-3, replies to ev-2)
    // Host 4 (Edge device): -150ms skew from Host 3, starts at 10:00:00.050Z (ev-4, replies to ev-3)
    // Raw timestamp order: Host 4 (0.050) < Host 3 (0.200) < Host 2 (0.700) < Host 1 (1.000)
    // Complete chronological inversion!
    const spans = [
      new SpanNode({
        span_id: "s-cloud",
        trace_id: "tr-cloud",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:01.000Z",
        attributes: { "agent.name": "cloud-planner", "nostr.event_id": "ev-1" },
      }),
      new SpanNode({
        span_id: "s-nuc",
        trace_id: "tr-nuc",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:00.700Z",
        attributes: { "agent.name": "nuc-architect", "nostr.event_id": "ev-2", "nostr.reply_to": "ev-1" },
      }),
      new SpanNode({
        span_id: "s-wsl2",
        trace_id: "tr-wsl2",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:00.200Z",
        attributes: { "agent.name": "wsl2-coder", "nostr.event_id": "ev-3", "nostr.reply_to": "ev-2" },
      }),
      new SpanNode({
        span_id: "s-edge",
        trace_id: "tr-edge",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T10:00:00.050Z",
        attributes: { "agent.name": "edge-tester", "nostr.event_id": "ev-4", "nostr.reply_to": "ev-3" },
      }),
    ];

    const aggregator = new ThreadAggregator("thread-multi-skew", "mobile");
    const telemetry = aggregator.aggregate(spans);

    // Topological order MUST prevail over raw timestamps
    expect(telemetry.turns).toHaveLength(4);
    expect(telemetry.turns[0].agentName).toBe("cloud-planner");
    expect(telemetry.turns[0].turnIndex).toBe(1);

    expect(telemetry.turns[1].agentName).toBe("nuc-architect");
    expect(telemetry.turns[1].turnIndex).toBe(2);
    expect(telemetry.turns[1].parentTurnIndex).toBe(1);

    expect(telemetry.turns[2].agentName).toBe("wsl2-coder");
    expect(telemetry.turns[2].turnIndex).toBe(3);
    expect(telemetry.turns[2].parentTurnIndex).toBe(2);

    expect(telemetry.turns[3].agentName).toBe("edge-tester");
    expect(telemetry.turns[3].turnIndex).toBe(4);
    expect(telemetry.turns[3].parentTurnIndex).toBe(3);

    // Exactly 3 CLOCK_SKEW anomalies should be generated
    const skewAnomalies = telemetry.anomalies.filter((a) => a.type === "CLOCK_SKEW");
    expect(skewAnomalies).toHaveLength(3);

    // Skew 1: Host 2 vs Host 1 (300ms)
    expect(skewAnomalies[0].turnIndex).toBe(2);
    expect(skewAnomalies[0].details?.skewMs).toBe(300);
    expect(skewAnomalies[0].details?.parentTurnIndex).toBe(1);

    // Skew 2: Host 3 vs Host 2 (500ms)
    expect(skewAnomalies[1].turnIndex).toBe(3);
    expect(skewAnomalies[1].details?.skewMs).toBe(500);
    expect(skewAnomalies[1].details?.parentTurnIndex).toBe(2);

    // Skew 3: Host 4 vs Host 3 (150ms)
    expect(skewAnomalies[2].turnIndex).toBe(4);
    expect(skewAnomalies[2].details?.skewMs).toBe(150);
    expect(skewAnomalies[2].details?.parentTurnIndex).toBe(3);
  });

  it("should handle multi-root threads and orphaned turns gracefully", () => {
    // Scenario:
    // Root 1: ev-root-1 (Channel message A)
    // Root 2: ev-root-2 (Channel message B)
    // Orphan: ev-orphan (Replies to ev-ghost-outside-telemetry)
    // Child 1A: replies to ev-root-1
    // Child 2A: replies to ev-root-2
    const spans = [
      new SpanNode({
        span_id: "s-r1",
        trace_id: "tr-r1",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T14:00:00.000Z",
        attributes: { "agent.name": "agent-root-1", "nostr.event_id": "ev-root-1" },
      }),
      new SpanNode({
        span_id: "s-r2",
        trace_id: "tr-r2",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T14:00:01.000Z",
        attributes: { "agent.name": "agent-root-2", "nostr.event_id": "ev-root-2" },
      }),
      new SpanNode({
        span_id: "s-orph",
        trace_id: "tr-orph",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T14:00:02.000Z",
        attributes: { "agent.name": "agent-orphaned", "nostr.event_id": "ev-orphan", "nostr.reply_to": "ev-ghost-999" },
      }),
      new SpanNode({
        span_id: "s-c1",
        trace_id: "tr-c1",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T14:00:03.000Z",
        attributes: { "agent.name": "agent-child-1", "nostr.event_id": "ev-c1", "nostr.reply_to": "ev-root-1" },
      }),
      new SpanNode({
        span_id: "s-c2",
        trace_id: "tr-c2",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T14:00:04.000Z",
        attributes: { "agent.name": "agent-child-2", "nostr.event_id": "ev-c2", "nostr.reply_to": "ev-root-2" },
      }),
    ];

    const aggregator = new ThreadAggregator("thread-multi-root", "mobile");
    const telemetry = aggregator.aggregate(spans);

    expect(telemetry.turns).toHaveLength(5);
    // Root turns should be turns 1, 2, and 3 (the orphan is treated as a root because parent is missing)
    expect(telemetry.dag?.rootIndices).toHaveLength(3);
    expect(telemetry.dag?.rootIndices).toContain(1);
    expect(telemetry.dag?.rootIndices).toContain(2);
    expect(telemetry.dag?.rootIndices).toContain(3);

    const orphanTurn = telemetry.turns.find((t) => t.agentName === "agent-orphaned");
    expect(orphanTurn).toBeDefined();
    expect(orphanTurn?.parentTurnIndex).toBeNull();
    expect(orphanTurn?.depth).toBe(0);
  });

  it("should survive cyclic event references without crashing or infinite recursion", () => {
    // Malformed/Adversarial telemetry:
    // Turn A (ev-loop-a) replies to Turn B (ev-loop-b)
    // Turn B (ev-loop-b) replies to Turn A (ev-loop-a)
    // Turn C (ev-valid) is a standard valid turn
    const spans = [
      new SpanNode({
        span_id: "s-c",
        trace_id: "tr-c",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T15:00:00.000Z",
        attributes: { "agent.name": "valid-agent", "nostr.event_id": "ev-valid" },
      }),
      new SpanNode({
        span_id: "s-loop-a",
        trace_id: "tr-loop-a",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T15:00:01.000Z",
        attributes: { "agent.name": "loop-a", "nostr.event_id": "ev-loop-a", "nostr.reply_to": "ev-loop-b" },
      }),
      new SpanNode({
        span_id: "s-loop-b",
        trace_id: "tr-loop-b",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T15:00:02.000Z",
        attributes: { "agent.name": "loop-b", "nostr.event_id": "ev-loop-b", "nostr.reply_to": "ev-loop-a" },
      }),
    ];

    const aggregator = new ThreadAggregator("thread-cycle", "mobile");
    // Aggregate must NOT throw RangeError: Maximum call stack size exceeded
    const telemetry = aggregator.aggregate(spans);

    expect(telemetry.turns).toHaveLength(3);
    expect(telemetry.status).toBe("OK");
    // Turn 1 should be the valid root node resolved by Kahn's algorithm
    expect(telemetry.turns[0].agentName).toBe("valid-agent");
    expect(telemetry.turns[0].turnIndex).toBe(1);
    expect(telemetry.dag?.rootIndices).toEqual([1]);
  });

  it("should handle simultaneous concurrent replies with identical millisecond timestamps", () => {
    // Root at T = 16:00:00.000Z
    // Agent B and Agent C reply simultaneously at exact same millisecond: T = 16:00:01.000Z
    const spans = [
      new SpanNode({
        span_id: "s-root",
        trace_id: "tr-root",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T16:00:00.000Z",
        attributes: { "agent.name": "root-lead", "nostr.event_id": "ev-root" },
      }),
      new SpanNode({
        span_id: "s-b",
        trace_id: "tr-b",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T16:00:01.000Z",
        attributes: { "agent.name": "agent-b", "nostr.event_id": "ev-b", "nostr.reply_to": "ev-root" },
      }),
      new SpanNode({
        span_id: "s-c",
        trace_id: "tr-c",
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: "2026-11-01T16:00:01.000Z",
        attributes: { "agent.name": "agent-c", "nostr.event_id": "ev-c", "nostr.reply_to": "ev-root" },
      }),
    ];

    const aggregator = new ThreadAggregator("thread-simultaneous", "mobile");
    const telemetry = aggregator.aggregate(spans);

    expect(telemetry.turns).toHaveLength(3);
    expect(telemetry.turns[0].agentName).toBe("root-lead");
    expect(telemetry.turns[0].turnIndex).toBe(1);
    expect(telemetry.turns[0].childrenTurnIndices).toEqual([2, 3]);

    expect(telemetry.turns[1].parentTurnIndex).toBe(1);
    expect(telemetry.turns[2].parentTurnIndex).toBe(1);

    // Both should be partitioned into separate branches
    expect(telemetry.turns[1].branchId).toBe("main");
    expect(telemetry.turns[2].branchId).toBe("branch-turn1-2");
  });

  it("detects causal overlap clock skew when child starts before parent turn finishes", () => {
    const parentSpan = new SpanNode({
      span_id: "sp-parent",
      trace_id: "tr-parent",
      name: "agent_turn",
      start_time: "2026-11-01T10:00:00.000Z",
      end_time: "2026-11-01T10:00:10.000Z", // Parent took 10s
      status_code: "OK",
      attributes: {
        "session.id": "thread-overlap",
        "agent.name": "parent-agent",
        "nostr.event_id": "ev-parent-1",
      },
    });

    const childSpan = new SpanNode({
      span_id: "sp-child",
      trace_id: "tr-child",
      name: "agent_turn",
      start_time: "2026-11-01T10:00:05.000Z", // Child started at 5s (5000ms before parent finished!)
      end_time: "2026-11-01T10:00:15.000Z",
      status_code: "OK",
      attributes: {
        "session.id": "thread-overlap",
        "agent.name": "child-agent",
        "nostr.event_id": "ev-child-1",
        "nostr.reply_to": "ev-parent-1",
      },
    });

    const agg = new ThreadAggregator("thread-overlap", "mobile", null, "http://localhost:6006");
    const result = agg.aggregate([parentSpan, childSpan]);

    const overlap = result.anomalies.find((a) => a.type === "CLOCK_SKEW" && a.message.includes("Causal overlap"));
    expect(overlap).toBeDefined();
    expect(overlap?.details?.skewMs).toBe(5000);
  });
});
