import { describe, it, expect } from "vitest";
import { TraceDiffer } from "../src/engine/differ.js";
import { AgentTurn, ThreadTelemetry } from "../src/models.js";

describe("TraceDiffer (buzz-trace diff)", () => {
  const createMockTurn = (overrides: Partial<AgentTurn> = {}): AgentTurn => ({
    turnIndex: overrides.turnIndex ?? 1,
    traceId: overrides.traceId ?? "trace-001-aaaa-bbbb-cccc-111122223333",
    agentName: overrides.agentName ?? "agent-alpha",
    modelName: overrides.modelName ?? "claude-3-5-sonnet",
    durationMs: overrides.durationMs ?? 1500,
    promptTokens: overrides.promptTokens ?? 500,
    completionTokens: overrides.completionTokens ?? 200,
    reasoningTokens: overrides.reasoningTokens ?? 50,
    totalTokens: overrides.totalTokens ?? 750,
    modelCalls: overrides.modelCalls,
    contextPerCall: overrides.contextPerCall,
    statusCode: overrides.statusCode ?? "OK",
    statusMessage: overrides.statusMessage ?? null,
    promptPreview: overrides.promptPreview ?? "User question",
    responsePreview: overrides.responsePreview ?? "Agent response",
    tools: overrides.tools ?? [
      {
        name: "search_web",
        statusCode: "OK",
        durationMs: 300,
        error: null,
        inputSummary: "query test",
        outputBytes: 1024,
        spanId: "span-t1",
      },
    ],
    spans: [],
  });

  it("compares the context of one model call, not only the totals summed over a turn's calls", () => {
    // Round 1: 3 calls of ~23k (69k summed); round 4: 2 calls of ~72k (145k summed). The summed figure doubles; so does the
    // context, three times over.
    const a = createMockTurn({ turnIndex: 1, promptTokens: 69177, modelCalls: 3, contextPerCall: 23059 });
    const b = createMockTurn({ turnIndex: 4, promptTokens: 144581, modelCalls: 2, contextPerCall: 72291 });
    const result = new TraceDiffer().diff(a, b);
    expect(result.diff.context_per_call).toEqual({ a: 23059, b: 72291, delta_tokens: 49232, pct_change: 213.5 });
    expect(result.diff.model_calls).toEqual({ a: 3, b: 2, delta_count: -1 });
    expect(TraceDiffer.renderTerminal(result, false)).toContain("Context/call:      23,059 -> 72,291");
  });

  it("calculates exact metrics and delta when comparing two turns", () => {
    const turnA = createMockTurn({
      turnIndex: 1,
      modelName: "gpt-4o",
      durationMs: 2000,
      totalTokens: 1000,
      promptTokens: 800,
      completionTokens: 200,
    });

    const turnB = createMockTurn({
      turnIndex: 2,
      modelName: "gemini-3.8-flash",
      durationMs: 1200,
      totalTokens: 850,
      promptTokens: 650,
      completionTokens: 200,
    });

    const differ = new TraceDiffer();
    const result = differ.diff(turnA, turnB);

    // Model diff
    expect(result.diff.model.a).toBe("gpt-4o");
    expect(result.diff.model.b).toBe("gemini-3.8-flash");
    expect(result.diff.model.changed).toBe(true);

    // Duration diff
    expect(result.diff.duration_ms.a).toBe(2000);
    expect(result.diff.duration_ms.b).toBe(1200);
    expect(result.diff.duration_ms.delta_ms).toBe(-800);
    expect(result.diff.duration_ms.pct_change).toBe(-40);

    // Token diff
    expect(result.diff.tokens.total.a).toBe(1000);
    expect(result.diff.tokens.total.b).toBe(850);
    expect(result.diff.tokens.total.delta_tokens).toBe(-150);
    expect(result.diff.tokens.prompt.delta_tokens).toBe(-150);
    expect(result.diff.tokens.completion.delta_tokens).toBe(0);
  });

  it("detects tool execution status changes and error transitions", () => {
    const turnA = createMockTurn({
      tools: [
        {
          name: "run_command",
          statusCode: "OK",
          durationMs: 100,
          error: null,
          inputSummary: "ls -la",
          outputBytes: 50,
          spanId: "s1",
        },
      ],
    });

    const turnB = createMockTurn({
      tools: [
        {
          name: "run_command",
          statusCode: "ERROR",
          durationMs: 550,
          error: "exit code 127: command not found",
          inputSummary: "invalid_cmd",
          outputBytes: 0,
          spanId: "s2",
        },
      ],
    });

    const differ = new TraceDiffer();
    const result = differ.diff(turnA, turnB);

    expect(result.diff.tools.count.a).toBe(1);
    expect(result.diff.tools.count.b).toBe(1);
    expect(result.diff.tools.count.delta_count).toBe(0);

    const toolDiff = result.diff.tools.status_diff[0];
    expect(toolDiff.name).toBe("run_command");
    expect(toolDiff.status_a).toBe("OK");
    expect(toolDiff.status_b).toBe("ERROR");
    expect(toolDiff.error_b).toBe("exit code 127: command not found");
    expect(toolDiff.changed).toBe(true);
    expect(toolDiff.delta_ms).toBe(450);
  });

  it("handles different tool execution counts (added/removed tools)", () => {
    const turnA = createMockTurn({ tools: [] });
    const turnB = createMockTurn({
      tools: [
        {
          name: "fetch_url",
          statusCode: "OK",
          durationMs: 250,
          error: null,
          inputSummary: "https://example.com",
          outputBytes: 500,
          spanId: "s1",
        },
        {
          name: "parse_html",
          statusCode: "OK",
          durationMs: 50,
          error: null,
          inputSummary: "<html>",
          outputBytes: 200,
          spanId: "s2",
        },
      ],
    });

    const differ = new TraceDiffer();
    const result = differ.diff(turnA, turnB);

    expect(result.diff.tools.count.a).toBe(0);
    expect(result.diff.tools.count.b).toBe(2);
    expect(result.diff.tools.count.delta_count).toBe(2);
    expect(result.diff.tools.status_diff).toHaveLength(2);
    expect(result.diff.tools.status_diff[0].status_a).toBeNull();
    expect(result.diff.tools.status_diff[0].status_b).toBe("OK");
  });

  it("resolves target turns from ThreadTelemetry correctly", () => {
    const turn1 = createMockTurn({ turnIndex: 1, traceId: "trace-11111111111111111111111111111111" });
    const turn2 = createMockTurn({ turnIndex: 2, traceId: "trace-22222222222222222222222222222222" });

    const telemetry = new ThreadTelemetry({
      threadId: "test-thread",
      project: "mobile",
      turns: [turn1, turn2],
    });

    // 1. By explicit turn index
    const resTurn1 = TraceDiffer.resolveTurnFromTelemetry(telemetry, "test-thread", 1);
    expect(resTurn1.turn.turnIndex).toBe(1);

    // 2. By trace ID matching
    const resTrace = TraceDiffer.resolveTurnFromTelemetry(telemetry, "trace-22222222222222222222222222222222");
    expect(resTrace.turn.turnIndex).toBe(2);

    // 3. Fallback to latest turn
    const resDefault = TraceDiffer.resolveTurnFromTelemetry(telemetry, "test-thread");
    expect(resDefault.turn.turnIndex).toBe(2);
  });

  it("renders terminal format with clear visual sections", () => {
    const turnA = createMockTurn({ turnIndex: 1, durationMs: 1000, totalTokens: 500 });
    const turnB = createMockTurn({ turnIndex: 2, durationMs: 1500, totalTokens: 600 });

    const differ = new TraceDiffer();
    const result = differ.diff(turnA, turnB);
    const terminalOutput = TraceDiffer.renderTerminal(result, false);

    expect(terminalOutput).toContain("TRACE EXECUTION DIFF");
    expect(terminalOutput).toContain("Model:");
    expect(terminalOutput).toContain("Duration:");
    expect(terminalOutput).toContain("Total Tokens:");
    expect(terminalOutput).toContain("Tool Executions:");
  });
});
