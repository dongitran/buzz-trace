import { describe, it, expect } from "vitest";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { MarkdownRenderer } from "../src/formatters/markdown.js";
import { TerminalRenderer } from "../src/formatters/terminal.js";
import { ThreadTelemetry } from "../src/models.js";

describe("Formatters", () => {
  const telemetry = new ThreadTelemetry({
    threadId: "test-thread-abc",
    project: "mobile",
    sessionId: "sess-123",
    totalTurns: 1,
    totalTokens: 1000,
    totalPromptTokens: 900,
    totalCompletionTokens: 100,
    totalDurationMs: 4000,
    status: "OK",
    turns: [
      {
        turnIndex: 1,
        traceId: "trace-xyz",
        agentName: "phoenix-twin",
        modelName: "gemini-3.8-flash",
        durationMs: 4000,
        promptTokens: 900,
        completionTokens: 100,
        reasoningTokens: 0,
        totalTokens: 1000,
        statusCode: "OK",
        statusMessage: null,
        promptPreview: "prompt text",
        responsePreview: "response text",
        tools: [
          {
            name: "run_command",
            durationMs: 500,
            statusCode: "OK",
            error: null,
            inputSummary: "ls -la",
            outputBytes: 50,
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
        message: "Slow execution",
        turnIndex: 1,
      },
    ],
  });

  it("should render JSON properly", () => {
    const renderer = new JsonRenderer();
    const jsonStr = renderer.render(telemetry);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.thread_id).toBe("test-thread-abc");
    expect(parsed.turns).toHaveLength(1);
  });

  it("should render Markdown properly", () => {
    const renderer = new MarkdownRenderer();
    const md = renderer.render(telemetry);
    expect(md).toContain("# Thread Execution Report: `test-thread-abc`");
    expect(md).toContain("| **1** | `phoenix-twin` | `gemini-3.8-flash` |");
    expect(md).toContain("### Turn 1 (phoenix-twin)");
    expect(md).toContain("`run_command`");
  });

  it("should render Terminal with verbose mode", () => {
    const renderer = new TerminalRenderer(false);
    const term = renderer.render(telemetry, true);
    expect(term).toContain("BUZZ-TRACE");
    expect(term).toContain("test-thread-abc");
    expect(term).toContain("phoenix-twin");
    expect(term).toContain("run_command");
    expect(term).toContain("response text");
  });
});
