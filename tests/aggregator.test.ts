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
});
