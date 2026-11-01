import { describe, it, expect } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { ThreadQueryEngine } from "../src/engine/query.js";
import { SpanNode } from "../src/models.js";

describe("ThreadQueryEngine", () => {
  const spans = [
    new SpanNode({
      span_id: "s1",
      trace_id: "trace-1",
      name: "agent_turn",
      status_code: "OK",
      start_time: "2026-11-01T08:00:00Z",
      end_time: "2026-11-01T08:00:05Z",
      attributes: { "session.id": "thread-1", "agent.name": "agent-lead" },
    }),
    new SpanNode({
      span_id: "s2",
      trace_id: "trace-2",
      name: "agent_turn",
      status_code: "ERROR",
      status_message: "Compilation failed",
      start_time: "2026-11-01T08:00:10Z",
      end_time: "2026-11-01T08:00:20Z",
      attributes: { "session.id": "thread-1", "agent.name": "agent-builder" },
    }),
    new SpanNode({
      span_id: "s3",
      trace_id: "trace-2",
      parent_id: "s2",
      name: "tool:run_command",
      status_code: "ERROR",
      status_message: "exit code 1",
      attributes: { "tool.name": "run_command", "input.value": "npm build" },
    }),
    new SpanNode({
      span_id: "s4",
      trace_id: "trace-3",
      name: "agent_turn",
      status_code: "OK",
      start_time: "2026-11-01T08:00:30Z",
      end_time: "2026-11-01T08:00:35Z",
      attributes: { "session.id": "thread-1", "agent.name": "agent-reviewer" },
    }),
    new SpanNode({
      span_id: "s5",
      trace_id: "trace-3",
      parent_id: "s4",
      name: "tool:read_file",
      status_code: "OK",
      attributes: { "tool.name": "read_file", "input.value": "package.json" },
    }),
  ];

  const aggregator = new ThreadAggregator("thread-1", "mobile", null, "http://localhost:6006");
  const telemetry = aggregator.aggregate(spans);
  const engine = new ThreadQueryEngine();

  it("filters turns by agent name substring", () => {
    const res = engine.filter(telemetry, { agentFilter: "builder" });
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0].agentName).toBe("agent-builder");
  });

  it("filters turns by failures only", () => {
    const res = engine.filter(telemetry, { failuresOnly: true });
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0].agentName).toBe("agent-builder");
    expect(res.turns[0].statusCode).toBe("ERROR");
    expect(res.turns[0].tools[0].statusCode).toBe("ERROR");
  });

  it("filters turns by tools only", () => {
    const res = engine.filter(telemetry, { toolsOnly: true });
    expect(res.turns).toHaveLength(2);
  });

  it("filters turns by specific tool name", () => {
    const res = engine.filter(telemetry, { toolName: "read_file" });
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0].agentName).toBe("agent-reviewer");
  });

  it("tails last N turns", () => {
    const res = engine.filter(telemetry, { lastN: 2 });
    expect(res.turns).toHaveLength(2);
    expect(res.turns[0].turnIndex).toBe(2);
    expect(res.turns[1].turnIndex).toBe(3);
  });

  it("filters by exact target turn index", () => {
    const res = engine.filter(telemetry, { targetTurn: 1 });
    expect(res.turns).toHaveLength(1);
    expect(res.turns[0].turnIndex).toBe(1);
    expect(res.turns[0].agentName).toBe("agent-lead");
  });

  it("prunes successful tools in failuresOnly mode to prevent token bloat", () => {
    const multiToolSpans = [
      new SpanNode({
        span_id: "m1",
        trace_id: "trace-multi",
        name: "agent_turn",
        status_code: "OK",
        attributes: { "session.id": "thread-multi", "agent.name": "worker" },
      }),
      // Successful tool 1
      new SpanNode({
        span_id: "t1",
        trace_id: "trace-multi",
        parent_id: "m1",
        name: "tool:read_file",
        status_code: "OK",
        attributes: { "tool.name": "read_file" },
      }),
      // Failing tool 2
      new SpanNode({
        span_id: "t2",
        trace_id: "trace-multi",
        parent_id: "m1",
        name: "tool:run_command",
        status_code: "ERROR",
        status_message: "command failed",
        attributes: { "tool.name": "run_command" },
      }),
      // Successful tool 3
      new SpanNode({
        span_id: "t3",
        trace_id: "trace-multi",
        parent_id: "m1",
        name: "tool:write_file",
        status_code: "OK",
        attributes: { "tool.name": "write_file" },
      }),
    ];

    const agg = new ThreadAggregator("thread-multi", "mobile", null, "http://localhost:6006");
    const multiTelem = agg.aggregate(multiToolSpans);
    expect(multiTelem.turns[0].tools).toHaveLength(3);

    const filtered = engine.filter(multiTelem, { failuresOnly: true });
    expect(filtered.turns).toHaveLength(1);
    // Successful tools (t1, t3) must be pruned, leaving only failing tool (t2)
    expect(filtered.turns[0].tools).toHaveLength(1);
    expect(filtered.turns[0].tools[0].name).toBe("run_command");
    expect(filtered.turns[0].tools[0].statusCode).toBe("ERROR");
  });
});
