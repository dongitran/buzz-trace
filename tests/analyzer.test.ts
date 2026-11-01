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
});
