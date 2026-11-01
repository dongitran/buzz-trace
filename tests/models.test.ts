import { describe, it, expect } from "vitest";
import { SpanNode, ThreadTelemetry } from "../src/models.js";

describe("SpanNode", () => {
  it("should correctly parse from raw data", () => {
    const raw = {
      context: { span_id: "s-123", trace_id: "t-456" },
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: "2026-11-01T06:11:10.000Z",
      end_time: "2026-11-01T06:11:15.000Z",
      status_code: "OK",
      attributes: { "session.id": "root-thread-1" },
    };

    const span = new SpanNode(raw);
    expect(span.spanId).toBe("s-123");
    expect(span.traceId).toBe("t-456");
    expect(span.name).toBe("agent_turn");
    expect(span.durationMs).toBe(5000);
    expect(span.statusCode).toBe("OK");
    expect(span.attributes["session.id"]).toBe("root-thread-1");
  });
});

describe("ThreadTelemetry", () => {
  it("should serialize to JSON properly", () => {
    const t = new ThreadTelemetry({
      threadId: "root-thread-1",
      project: "mobile",
      sessionId: "session-1",
      totalTurns: 1,
      totalTokens: 1000,
      totalPromptTokens: 800,
      totalCompletionTokens: 200,
      totalDurationMs: 5000,
      status: "OK",
      turns: [
        {
          turnIndex: 1,
          traceId: "t-1",
          agentName: "phoenix-twin",
          modelName: "gemini-3.8-flash-high",
          durationMs: 5000,
          promptTokens: 800,
          completionTokens: 200,
          reasoningTokens: 0,
          totalTokens: 1000,
          statusCode: "OK",
          statusMessage: null,
          promptPreview: "hello",
          responsePreview: "world",
          tools: [
            {
              name: "run_command",
              durationMs: 400,
              statusCode: "OK",
              inputSummary: "ls",
              outputBytes: 128,
              spanId: "sp-1",
            },
          ],
          spans: [],
        },
      ],
      anomalies: [
        {
          type: "LATENCY_SPIKE",
          severity: "INFO",
          message: "Slow turn",
          turnIndex: 1,
          traceId: "t-1",
        },
      ],
    });

    const json = t.toJSON();
    expect(json.thread_id).toBe("root-thread-1");
    expect(json.total_tokens).toBe(1000);
    expect(json.turns).toHaveLength(1);
    expect(json.turns[0].agent).toBe("phoenix-twin");
    expect(json.anomalies).toHaveLength(1);
    expect(json.anomalies[0].type).toBe("LATENCY_SPIKE");
  });
});
