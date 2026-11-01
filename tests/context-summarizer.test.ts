import { describe, it, expect } from "vitest";
import { ContextSummarizer } from "../src/engine/context-summarizer.js";
import { AgentTurn, ThreadTelemetry } from "../src/models.js";
import { countTokens } from "../src/tokenizer.js";

describe("ContextSummarizer (buzz-trace context)", () => {
  const createMockTurn = (index: number, overrides: Partial<AgentTurn> = {}): AgentTurn => ({
    turnIndex: index,
    traceId: `trace-${index.toString().padStart(4, "0")}`,
    agentName: overrides.agentName ?? (index % 2 === 1 ? "user-agent" : "worker-agent"),
    modelName: overrides.modelName ?? "gemini-3.8-flash",
    durationMs: overrides.durationMs ?? 500,
    promptTokens: overrides.promptTokens ?? 200,
    completionTokens: overrides.completionTokens ?? 100,
    reasoningTokens: 0,
    totalTokens: overrides.totalTokens ?? 300,
    statusCode: overrides.statusCode ?? "OK",
    statusMessage: overrides.statusMessage ?? null,
    promptPreview: overrides.promptPreview ?? `Prompt for turn ${index}`,
    responsePreview: overrides.responsePreview ?? `Response for turn ${index}`,
    tools: overrides.tools ?? [
      {
        name: "run_command",
        statusCode: "OK",
        durationMs: 50,
        error: null,
        inputSummary: `cmd_${index}`,
        outputBytes: 100,
        spanId: `s_${index}`,
      },
    ],
    spans: [],
  });

  it("prioritizes root intent, latest outcome, and failed tools across multi-turn thread", () => {
    const turns = [
      createMockTurn(1, {
        promptPreview: "Root Intent: Fix the broken build on simplemdg-v2",
        responsePreview: "I will check the build logs",
      }),
      createMockTurn(2, {
        promptPreview: "Intermediate turn 2",
        responsePreview: "Intermediate chatter response 2",
      }),
      createMockTurn(3, {
        promptPreview: "Running test suite",
        responsePreview: "Test suite failed with an exception",
        tools: [
          {
            name: "run_test",
            statusCode: "ERROR",
            durationMs: 1200,
            error: "AssertionError: Expected 200 but got 500",
            inputSummary: "npm test",
            outputBytes: 256,
            spanId: "tool-fail-3",
          },
        ],
      }),
      createMockTurn(4, {
        promptPreview: "Investigating error",
        responsePreview: "Intermediate chatter response 4",
      }),
      createMockTurn(5, {
        promptPreview: "Latest turn action",
        responsePreview: "Final Outcome: Successfully resolved test failure",
        statusCode: "OK",
      }),
    ];

    const telemetry = new ThreadTelemetry({
      threadId: "multi-agent-thread-42",
      project: "mobile",
      turns,
    });

    const summarizer = new ContextSummarizer();
    const summary = summarizer.summarize(telemetry, { budget: 300, flat: true });

    // Invariant: Root intent preserved
    expect(summary.root_intent).toContain("Root Intent: Fix the broken build");

    // Invariant: Latest outcome preserved
    expect(summary.latest_outcome.turn).toBe(5);
    expect(summary.latest_outcome.response).toContain("Final Outcome");

    // Invariant: Failed tools captured
    expect(summary.failed_tools).toHaveLength(1);
    expect(summary.failed_tools[0].turn).toBe(3);
    expect(summary.failed_tools[0].name).toBe("run_test");
    expect(summary.failed_tools[0].status).toBe("ERROR");
    expect(summary.failed_tools[0].error).toContain("AssertionError");

    // Invariant: Intermediate turns pruned
    expect(summary.total_turns).toBe(5);
    expect(summary.pruned_turns).toBe(3);

    // Invariant: Tokens strictly within budget
    expect(summary.actual_tokens).toBeLessThanOrEqual(300);
  });

  it("strictly enforces low token budgets (e.g. 150 tokens) with adaptive trimming", () => {
    const turns = [
      createMockTurn(1, {
        promptPreview: "A very long detailed prompt explaining all the background information and requirements ".repeat(10),
      }),
      createMockTurn(2, {
        promptPreview: "Long middle turn",
        responsePreview: "Long middle response ".repeat(10),
      }),
      createMockTurn(3, {
        promptPreview: "Long final prompt",
        responsePreview: "A very verbose final response containing lots of details and explanations ".repeat(10),
        tools: [
          {
            name: "failing_tool",
            statusCode: "ERROR",
            durationMs: 999,
            error: "Huge error trace with lots of stack traces ".repeat(5),
            inputSummary: "args",
            outputBytes: 100,
            spanId: "fail-tool",
          },
        ],
      }),
    ];

    const telemetry = new ThreadTelemetry({
      threadId: "bloated-thread-99",
      project: "mobile",
      turns,
    });

    const summarizer = new ContextSummarizer();
    const budget = 150;
    const summary = summarizer.summarize(telemetry, { budget, flat: true });

    const flatJson = JSON.stringify(summary);
    const measuredTokens = countTokens(flatJson);

    // Strict invariant: measuredTokens <= budget
    expect(measuredTokens).toBeLessThanOrEqual(budget);
    expect(summary.actual_tokens).toBeLessThanOrEqual(budget);
    expect(flatJson).not.toContain("\n");
  });

  it("handles single-turn threads gracefully", () => {
    const turns = [
      createMockTurn(1, {
        promptPreview: "Single turn prompt",
        responsePreview: "Single turn response",
      }),
    ];

    const telemetry = new ThreadTelemetry({
      threadId: "single-turn-thread",
      project: "mobile",
      turns,
    });

    const summarizer = new ContextSummarizer();
    const summary = summarizer.summarize(telemetry, { budget: 200, flat: true });

    expect(summary.total_turns).toBe(1);
    expect(summary.pruned_turns).toBe(0);
    expect(summary.root_intent).toBe("Single turn prompt");
    expect(summary.latest_outcome.response).toBe("Single turn response");
    expect(summary.actual_tokens).toBeLessThanOrEqual(200);
  });

  it("renders human readable terminal view", () => {
    const turns = [createMockTurn(1)];
    const telemetry = new ThreadTelemetry({
      threadId: "term-thread",
      project: "mobile",
      turns,
    });

    const summarizer = new ContextSummarizer();
    const summary = summarizer.summarize(telemetry, { budget: 200 });
    const rendered = ContextSummarizer.render(summary, { noColor: true });

    expect(rendered).toContain("BUZZ-TRACE ADAPTIVE CONTEXT SUMMARY");
    expect(rendered).toContain("[1. ROOT INTENT]");
    expect(rendered).toContain("[2. LATEST TURN OUTCOME]");
    expect(rendered).toContain("[3. FAILED TOOLS]");
  });
});
