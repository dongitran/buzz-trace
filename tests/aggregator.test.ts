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
});
