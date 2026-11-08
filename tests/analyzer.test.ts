import { describe, it, expect } from "vitest";
import { AnomalyDetector } from "../src/engine/analyzer.js";
import { ThreadTelemetry } from "../src/models.js";

describe("AnomalyDetector", () => {
  it("should flag context canceled as CRITICAL anomaly", () => {
    const t = new ThreadTelemetry({
      threadId: "th-cancel",
      turns: [
        {
          turnIndex: 1,
          traceId: "tr-1",
          agentName: "phoenix-twin",
          modelName: "gemini-3.8-flash",
          durationMs: 1000,
          promptTokens: 100,
          completionTokens: 10,
          reasoningTokens: 0,
          totalTokens: 110,
          statusCode: "ERROR",
          statusMessage: "upstream context canceled by client",
          promptPreview: "",
          responsePreview: "",
          tools: [],
          spans: [],
        },
      ],
    });

    const detector = new AnomalyDetector();
    const anomalies = detector.analyze(t);

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].type).toBe("CONTEXT_CANCELED");
    expect(anomalies[0].severity).toBe("CRITICAL");
  });

  it("should detect repeating tool loops", () => {
    const t = new ThreadTelemetry({
      threadId: "th-loop",
      turns: [
        {
          turnIndex: 1,
          traceId: "tr-2",
          agentName: "phoenix-twin",
          modelName: "gemini-3.8-flash",
          durationMs: 1000,
          promptTokens: 100,
          completionTokens: 10,
          reasoningTokens: 0,
          totalTokens: 110,
          statusCode: "OK",
          statusMessage: null,
          promptPreview: "",
          responsePreview: "",
          tools: [
            { name: "read_file", durationMs: 10, statusCode: "OK", inputSummary: "/foo/bar.txt", outputBytes: 10, spanId: "s1" },
            { name: "read_file", durationMs: 10, statusCode: "OK", inputSummary: "/foo/bar.txt", outputBytes: 10, spanId: "s2" },
            { name: "read_file", durationMs: 10, statusCode: "OK", inputSummary: "/foo/bar.txt", outputBytes: 10, spanId: "s3" },
          ],
          spans: [],
        },
      ],
    });

    const detector = new AnomalyDetector({ toolLoopThreshold: 3 });
    const anomalies = detector.analyze(t);

    expect(anomalies.some((a) => a.type === "TOOL_LOOP")).toBe(true);
  });

  it("should warn on excessive prompt token bloat", () => {
    const t = new ThreadTelemetry({
      threadId: "th-bloat",
      turns: [
        {
          turnIndex: 1,
          traceId: "tr-3",
          agentName: "phoenix-twin",
          modelName: "gemini-3.8-flash",
          durationMs: 1000,
          promptTokens: 180000,
          completionTokens: 10,
          reasoningTokens: 0,
          totalTokens: 180010,
          statusCode: "OK",
          statusMessage: null,
          promptPreview: "",
          responsePreview: "",
          tools: [],
          spans: [],
        },
      ],
    });

    const detector = new AnomalyDetector({ tokenBloatThreshold: 150000 });
    const anomalies = detector.analyze(t);

    expect(anomalies.some((a) => a.type === "TOKEN_BLOAT")).toBe(true);
  });

  it("should detect token inflation (exponential token growth) between turns", () => {
    const t = new ThreadTelemetry({
      threadId: "th-inflation",
      turns: [
        {
          turnIndex: 1,
          traceId: "tr-1",
          agentName: "phoenix-twin",
          modelName: "gemini-3.8-flash",
          durationMs: 1000,
          promptTokens: 5000,
          completionTokens: 200,
          reasoningTokens: 0,
          totalTokens: 5200,
          statusCode: "OK",
          statusMessage: null,
          promptPreview: "",
          responsePreview: "",
          tools: [],
          spans: [],
        },
        {
          turnIndex: 2,
          traceId: "tr-2",
          agentName: "coder-agent",
          modelName: "gemini-3.8-flash",
          durationMs: 2000,
          promptTokens: 30000, // 6x growth (+25k tokens!)
          completionTokens: 500,
          reasoningTokens: 0,
          totalTokens: 30500,
          statusCode: "OK",
          statusMessage: null,
          promptPreview: "",
          responsePreview: "",
          tools: [],
          spans: [],
        },
      ],
    });

    const detector = new AnomalyDetector({ tokenInflationMultiplier: 2.0, tokenInflationMinDelta: 15000 });
    const anomalies = detector.analyze(t);

    const inflation = anomalies.find((a) => a.type === "TOKEN_INFLATION");
    expect(inflation).toBeDefined();
    expect(inflation?.turnIndex).toBe(2);
    expect(inflation?.details?.ratio).toBe(6);
    expect(inflation?.details?.deltaTokens).toBe(25000);
  });

  it("should detect slow tool executions exceeding 5s threshold", () => {
    const t = new ThreadTelemetry({
      threadId: "th-slow-tool",
      turns: [
        {
          turnIndex: 1,
          traceId: "tr-1",
          agentName: "phoenix-twin",
          modelName: "gemini-3.8-flash",
          durationMs: 7000,
          promptTokens: 1000,
          completionTokens: 100,
          reasoningTokens: 0,
          totalTokens: 1100,
          statusCode: "OK",
          statusMessage: null,
          promptPreview: "",
          responsePreview: "",
          tools: [
            {
              name: "repo_search",
              durationMs: 6200, // > 5s
              statusCode: "OK",
              inputSummary: "find symbols",
              outputBytes: 500,
              spanId: "sp-slow",
            },
          ],
          spans: [],
        },
      ],
    });

    const detector = new AnomalyDetector({ slowToolMs: 5000 });
    const anomalies = detector.analyze(t);

    const slowTool = anomalies.find((a) => a.type === "SLOW_TOOL");
    expect(slowTool).toBeDefined();
    expect(slowTool?.severity).toBe("WARNING");
    expect(slowTool?.message).toContain("repo_search");
    expect(slowTool?.details?.durationMs).toBe(6200);
  });

  it("should detect thread-level slow tool P95 latency spikes across multiple tool executions", () => {
    const t = new ThreadTelemetry({
      threadId: "th-p95",
      turns: [
        {
          turnIndex: 1,
          traceId: "tr-1",
          agentName: "phoenix-twin",
          modelName: "gemini-3.8-flash",
          durationMs: 15000,
          promptTokens: 1000,
          completionTokens: 100,
          reasoningTokens: 0,
          totalTokens: 1100,
          statusCode: "OK",
          statusMessage: null,
          promptPreview: "",
          responsePreview: "",
          tools: [
            { name: "tool1", durationMs: 200, statusCode: "OK", inputSummary: "", outputBytes: 10, spanId: "s1" },
            { name: "tool2", durationMs: 300, statusCode: "OK", inputSummary: "", outputBytes: 10, spanId: "s2" },
            { name: "tool3", durationMs: 400, statusCode: "OK", inputSummary: "", outputBytes: 10, spanId: "s3" },
            { name: "tool4", durationMs: 500, statusCode: "OK", inputSummary: "", outputBytes: 10, spanId: "s4" },
            { name: "tool5", durationMs: 5500, statusCode: "OK", inputSummary: "", outputBytes: 10, spanId: "s5" },
          ],
          spans: [],
        },
      ],
    });

    const detector = new AnomalyDetector({ slowToolMs: 5000 });
    const anomalies = detector.analyze(t);

    const p95Anomaly = anomalies.find((a) => a.type === "SLOW_TOOL" && a.message.includes("P95"));
    expect(p95Anomaly).toBeDefined();
    expect(p95Anomaly?.details?.p95DurationMs).toBe(5500);
  });

  it("should detect unhandled agent exceptions as CRITICAL", () => {
    const t = new ThreadTelemetry({
      threadId: "th-unhandled",
      turns: [
        {
          turnIndex: 1,
          traceId: "tr-err",
          agentName: "coder-agent",
          modelName: "gemini-3.8-flash",
          durationMs: 500,
          promptTokens: 1000,
          completionTokens: 0,
          reasoningTokens: 0,
          totalTokens: 1000,
          statusCode: "ERROR",
          statusMessage: "ResourceExhausted: 429 Quota exceeded for quota metric 'GenerateContent'",
          promptPreview: "",
          responsePreview: "",
          tools: [],
          spans: [],
        },
      ],
    });

    const detector = new AnomalyDetector();
    const anomalies = detector.analyze(t);

    const unhandled = anomalies.find((a) => a.type === "UNHANDLED_EXCEPTION");
    expect(unhandled).toBeDefined();
    expect(unhandled?.severity).toBe("CRITICAL");
    expect(unhandled?.message).toContain("coder-agent");
    expect(unhandled?.message).toContain("ResourceExhausted");
  });
});

describe("AnomalyDetector token inflation across agents", () => {
  const turn = (turnIndex: number, agentName: string, promptTokens: number, parentTurnIndex: number | null) => ({
    turnIndex,
    traceId: `tr-${turnIndex}`,
    agentName,
    modelName: "sonnet",
    durationMs: 1000,
    promptTokens,
    completionTokens: 100,
    reasoningTokens: 0,
    totalTokens: promptTokens + 100,
    statusCode: "OK",
    statusMessage: null,
    promptPreview: "",
    responsePreview: "",
    parentTurnIndex,
    tools: [],
    spans: [],
  });

  it("compares a turn with the same agent's previous turn, not with another agent's smaller prompt", () => {
    // Kent hands off to Ann, whose prompt is small; Kent's next turn grows only a little over Kent's own first turn.
    const t = new ThreadTelemetry({
      threadId: "th-handoff",
      turns: [turn(1, "kent", 60000, null), turn(2, "ann", 20000, 1), turn(3, "kent", 65000, 2)],
    });
    const anomalies = new AnomalyDetector().analyze(t);
    expect(anomalies.filter((a) => a.type === "TOKEN_INFLATION")).toEqual([]);
  });

  it("still flags a same-agent turn whose prompt doubles", () => {
    const t = new ThreadTelemetry({
      threadId: "th-same-agent",
      turns: [turn(1, "kent", 30000, null), turn(2, "ann", 90000, 1), turn(3, "kent", 70000, 2)],
    });
    const inflation = new AnomalyDetector().analyze(t).filter((a) => a.type === "TOKEN_INFLATION");
    expect(inflation.map((a) => [a.turnIndex, a.details?.prevTurnIndex])).toEqual([
      [2, 1],
      [3, 1],
    ]);
  });
});
