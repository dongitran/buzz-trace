import { describe, it, expect } from "vitest";
import {
  extractSemanticToolInput,
  formatCompactTool,
  cleanWhitespace,
  TOOL_SEMANTIC_KEYS,
} from "../src/formatters/compact-fmt.js";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { ThreadQueryEngine } from "../src/engine/query.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { SpanNode, ToolExecution, ThreadTelemetry } from "../src/models.js";

describe("Semantic Tool Compactor & Escaping Eliminator", () => {
  describe("extractSemanticToolInput", () => {
    it("extracts core command from stringified JSON with CommandLine", () => {
      const raw = '{"CommandLine":"free -m && nproc"}';
      expect(extractSemanticToolInput(raw)).toBe("free -m && nproc");
    });

    it("extracts command from stringified JSON with command key", () => {
      const raw = '{"command":"git status --short"}';
      expect(extractSemanticToolInput(raw)).toBe("git status --short");
    });

    it("extracts cmd from stringified JSON with cmd key", () => {
      const raw = '{"cmd":"ls -la /tmp"}';
      expect(extractSemanticToolInput(raw)).toBe("ls -la /tmp");
    });

    it("extracts Path from stringified JSON with Path key", () => {
      const raw = '{"Path":"/home/user/workspace/index.ts"}';
      expect(extractSemanticToolInput(raw)).toBe("/home/user/workspace/index.ts");
    });

    it("extracts path from stringified JSON with path key", () => {
      const raw = '{"path":"/var/log/syslog"}';
      expect(extractSemanticToolInput(raw)).toBe("/var/log/syslog");
    });

    it("extracts query from stringified JSON with query key", () => {
      const raw = '{"query":"SELECT count(*) FROM traces"}';
      expect(extractSemanticToolInput(raw)).toBe("SELECT count(*) FROM traces");
    });

    it("eliminates nested triple-escaped subshell quotes and JSON boilerplate", () => {
      const raw = '{"CommandLine":"cat << \'EOF\' | buzz messages send --channel \\"01fd5ea1-0089-471b-9aac-96e54993a4ab\\""}';
      const extracted = extractSemanticToolInput(raw);
      expect(extracted).toBe('cat << \'EOF\' | buzz messages send --channel "01fd5ea1-0089-471b-9aac-96e54993a4ab"');
      expect(extracted).not.toContain('{\\"CommandLine\\":');
      expect(extracted).not.toContain('\\\\\\"');
    });

    it("handles multi-line shell commands and normalizes newlines to clean single-line", () => {
      const raw = '{"CommandLine":"cat << \'EOF\' > /tmp/test.sh\\n#!/bin/bash\\necho \\"Hello\\"\\nEOF\\n"}';
      const extracted = extractSemanticToolInput(raw);
      expect(extracted).toBe('cat << \'EOF\' > /tmp/test.sh #!/bin/bash echo "Hello" EOF');
      expect(extracted).not.toContain("\n");
    });

    it("recovers gracefully from truncated or malformed JSON via regex fallback", () => {
      // Truncated at 80 chars before closing quotes or braces
      const truncated = '{"CommandLine":"cat << \'EOF\' | buzz messages send --channel \\"01fd5ea1-0089';
      const extracted = extractSemanticToolInput(truncated);
      expect(extracted).toBe('cat << \'EOF\' | buzz messages send --channel "01fd5ea1-0089');
    });

    it("extracts from pre-parsed objects directly", () => {
      const obj = { CommandLine: "npm run test", WaitMsBeforeAsync: 5000, toolSummary: "Unit tests" };
      expect(extractSemanticToolInput(obj)).toBe("npm run test");
    });

    it("extracts from object with Path key ignoring extra options", () => {
      const obj = { Path: "/app/src/main.ts", Content: "console.log('hi')", Overwrite: true };
      expect(extractSemanticToolInput(obj)).toBe("/app/src/main.ts");
    });

    it("handles plain text strings with zero change", () => {
      expect(extractSemanticToolInput("ls -la")).toBe("ls -la");
      expect(extractSemanticToolInput("echo hello")).toBe("echo hello");
    });

    it("handles null, undefined, and empty string gracefully", () => {
      expect(extractSemanticToolInput(null)).toBe("");
      expect(extractSemanticToolInput(undefined)).toBe("");
      expect(extractSemanticToolInput("   ")).toBe("");
    });

    it("verifies cleanWhitespace and TOOL_SEMANTIC_KEYS completeness", () => {
      expect(TOOL_SEMANTIC_KEYS).toContain("CommandLine");
      expect(TOOL_SEMANTIC_KEYS).toContain("query");
      expect(TOOL_SEMANTIC_KEYS).toContain("Path");
      expect(cleanWhitespace("  hello   world  \n\t ")).toBe("hello world");
    });
  });

  describe("formatCompactTool", () => {
    it("formats a tool execution into a clean compact payload with max length truncation", () => {
      const tool: ToolExecution = {
        name: "run_command",
        durationMs: 42.4,
        statusCode: "OK",
        error: null,
        inputSummary: '{"CommandLine":"very_long_command_argument_that_needs_to_be_truncated_if_it_exceeds_length_limit"}',
        outputBytes: 100,
        spanId: "sp-1",
      };

      const compact = formatCompactTool(tool, 30);
      expect(compact.name).toBe("run_command");
      expect(compact.ok).toBe(true);
      expect(compact.dur_ms).toBe(42);
      expect(compact.in).toBe("very_long_command_argument_tha");
      expect(compact.in).toHaveLength(30);
      expect(compact.err).toBeUndefined();
    });

    it("includes error field when tool failed", () => {
      const tool: ToolExecution = {
        name: "run_command",
        durationMs: 15,
        statusCode: "ERROR",
        error: "Command exit code 1: permission denied",
        inputSummary: '{"CommandLine":"cat /root/secret.key"}',
        outputBytes: 0,
        spanId: "sp-err",
      };

      const compact = formatCompactTool(tool, 80);
      expect(compact.ok).toBe(false);
      expect(compact.in).toBe("cat /root/secret.key");
      expect(compact.err).toBe("Command exit code 1: permission denied");
    });
  });

  describe("Aggregator & Formatter Integration", () => {
    it("automatically extracts clean semantic commands during aggregation", () => {
      const spans = [
        new SpanNode({
          span_id: "s1",
          trace_id: "t1",
          name: "agent_turn",
          span_kind: "AGENT",
          status_code: "OK",
          attributes: { "session.id": "sess-test", "agent.name": "phoenix-twin" },
        }),
        new SpanNode({
          span_id: "s2",
          trace_id: "t1",
          name: "tool:run_command",
          span_kind: "TOOL",
          parent_id: "s1",
          attributes: {
            "tool.name": "run_command",
            "input.value": '{"CommandLine":"free -m && nproc"}',
          },
        }),
      ];

      const agg = new ThreadAggregator("test-th", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns[0].tools).toHaveLength(1);
      const tool = telemetry.turns[0].tools[0];
      expect(tool.inputSummary).toBe("free -m && nproc");

      const renderer = new JsonRenderer();
      const compactJson = renderer.render(telemetry, { compact: true, flat: true });
      const parsed = JSON.parse(compactJson);

      expect(parsed.turns[0].tools[0].in).toBe("free -m && nproc");
      // Verify no escaped JSON wrapper exists in output string
      expect(compactJson).not.toContain('{\\"CommandLine\\":');
    });
  });

  describe("ThreadQueryEngine filter with toolInput", () => {
    it("filters turns by tool command input substring", () => {
      const telemetry = new ThreadTelemetry({
        threadId: "th-query-test",
        project: "mobile",
        totalTurns: 2,
        turns: [
          {
            turnIndex: 1,
            traceId: "tr-1",
            agentName: "agent-1",
            modelName: "model-1",
            durationMs: 100,
            promptTokens: 10,
            completionTokens: 10,
            reasoningTokens: 0,
            totalTokens: 20,
            statusCode: "OK",
            statusMessage: null,
            promptPreview: "",
            responsePreview: "",
            tools: [
              {
                name: "run_command",
                durationMs: 50,
                statusCode: "OK",
                inputSummary: "free -m && nproc",
                outputBytes: 10,
                spanId: "sp-1",
              },
            ],
            spans: [],
          },
          {
            turnIndex: 2,
            traceId: "tr-2",
            agentName: "agent-2",
            modelName: "model-1",
            durationMs: 100,
            promptTokens: 10,
            completionTokens: 10,
            reasoningTokens: 0,
            totalTokens: 20,
            statusCode: "OK",
            statusMessage: null,
            promptPreview: "",
            responsePreview: "",
            tools: [
              {
                name: "read_file",
                durationMs: 20,
                statusCode: "OK",
                inputSummary: "/etc/hosts",
                outputBytes: 50,
                spanId: "sp-2",
              },
            ],
            spans: [],
          },
        ],
        anomalies: [],
      });

      const engine = new ThreadQueryEngine();

      // Query for "free -m"
      const resultCmd = engine.filter(telemetry, { toolInput: "free -m" });
      expect(resultCmd.turns).toHaveLength(1);
      expect(resultCmd.turns[0].turnIndex).toBe(1);

      // Query for "hosts"
      const resultPath = engine.filter(telemetry, { toolInput: "hosts" });
      expect(resultPath.turns).toHaveLength(1);
      expect(resultPath.turns[0].turnIndex).toBe(2);

      // Query for non-existent command
      const resultNone = engine.filter(telemetry, { toolInput: "docker" });
      expect(resultNone.turns).toHaveLength(0);
    });
  });
});
