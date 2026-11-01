import { describe, it, expect } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { ThreadQueryEngine } from "../src/engine/query.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { SpanNode } from "../src/models.js";

describe("Autonomous Metacognitive Feedback Loop", () => {
  it("generates single-line reflection payload strictly under 150 tokens for failed turns", () => {
    const failedSpans = [
      new SpanNode({
        span_id: "root-fail-1",
        trace_id: "trace-fail-1",
        name: "agent_turn",
        span_kind: "AGENT",
        status_code: "ERROR",
        status_message: "Tool execution failed: exit code 1",
        start_time: "2026-11-01T10:00:00Z",
        end_time: "2026-11-01T10:00:02Z",
        attributes: {
          "session.id": "meta-thread-test",
          "agent.name": "autonomous-coder",
          "input.value": "Execute data processing pipeline"
        }
      }),
      new SpanNode({
        span_id: "tool-fail-1",
        trace_id: "trace-fail-1",
        parent_id: "root-fail-1",
        name: "tool:run_command",
        span_kind: "TOOL",
        status_code: "ERROR",
        status_message: "exit code 1: SyntaxError: '(' was never closed",
        start_time: "2026-11-01T10:00:00.5Z",
        end_time: "2026-11-01T10:00:01.8Z",
        attributes: {
          "tool.name": "run_command",
          "input.value": "python3 data_pipeline.py",
          "tool.output_bytes": 128
        }
      })
    ];

    const aggregator = new ThreadAggregator("meta-thread-test", "mobile", null, "http://localhost:6006");
    const telemetry = aggregator.aggregate(failedSpans);

    const queryEngine = new ThreadQueryEngine();
    const filtered = queryEngine.filter(telemetry, { failuresOnly: true });

    const renderer = new JsonRenderer(0);
    const flatJson = renderer.render(filtered, { compact: true, flat: true });

    // 1. Invariant: Single-line zero whitespace
    expect(flatJson).not.toContain("\n");

    // 2. Parseable structure
    const parsed = JSON.parse(flatJson);
    expect(parsed.thread_id).toBe("meta-thread-test");
    expect(parsed.status).toBe("ERROR");
    expect(parsed.filtered_turns).toBe(1);

    // 3. Extraction capability
    const turn = parsed.turns[0];
    expect(turn.agent).toBe("autonomous-coder");
    expect(turn.tools[0].name).toBe("run_command");
    expect(turn.tools[0].ok).toBe(false);
    expect(turn.tools[0].err).toContain("SyntaxError");

    // 4. Token estimation invariant: ~4 chars per token -> ~450 chars max for <150 tokens
    expect(flatJson.length).toBeLessThan(450);
  });

  it("generates ultra-compact confirmation payload (<50 tokens) when healthy", () => {
    const successSpans = [
      new SpanNode({
        span_id: "root-ok-1",
        trace_id: "trace-ok-1",
        name: "agent_turn",
        span_kind: "AGENT",
        status_code: "OK",
        start_time: "2026-11-01T10:05:00Z",
        end_time: "2026-11-01T10:05:02Z",
        attributes: {
          "session.id": "meta-thread-healthy",
          "agent.name": "autonomous-coder"
        }
      }),
      new SpanNode({
        span_id: "tool-ok-1",
        trace_id: "trace-ok-1",
        parent_id: "root-ok-1",
        name: "tool:run_command",
        span_kind: "TOOL",
        status_code: "OK",
        start_time: "2026-11-01T10:05:00.5Z",
        end_time: "2026-11-01T10:05:01.8Z",
        attributes: {
          "tool.name": "run_command",
          "input.value": "python3 data_pipeline.py"
        }
      })
    ];

    const aggregator = new ThreadAggregator("meta-thread-healthy", "mobile", null, "http://localhost:6006");
    const telemetry = aggregator.aggregate(successSpans);

    const queryEngine = new ThreadQueryEngine();
    const filtered = queryEngine.filter(telemetry, { failuresOnly: true });

    const renderer = new JsonRenderer(0);
    const flatJson = renderer.render(filtered, { compact: true, flat: true });

    expect(flatJson).not.toContain("\n");
    const parsed = JSON.parse(flatJson);
    expect(parsed.status).toBe("OK");
    expect(parsed.filtered_turns).toBe(0);
    expect(parsed.turns).toHaveLength(0);

    // Ultra compact: under 120 chars (~30-40 tokens)
    expect(flatJson.length).toBeLessThan(120);
  });
});
