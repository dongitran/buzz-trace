import * as fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { main } from "../src/cli.js";
import { SpanNode } from "../src/models.js";
import { mockThread } from "./helpers/mock-phoenix.js";

describe("CLI", () => {
  it("should output version on --version", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["--version"]);
    expect(code).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
    expect(logSpy).toHaveBeenCalledWith(`buzz-trace ${pkg.version}`);
    logSpy.mockRestore();
  });

  it("should show help when no command is provided", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main([]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("USAGE:"));
    logSpy.mockRestore();
  });

  it("should execute inspect command with mock spans and Phoenix URLs", async () => {
    const mockSpans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "t-mock",
        name: "agent_turn",
        span_kind: "AGENT",
        status_code: "OK",
        attributes: { "session.id": "test-thread-id", "agent.name": "phoenix-twin" },
      }),
    ];

    const spyFetch = mockThread(mockSpans);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["inspect", "test-thread-id", "--no-color"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("test-thread-id"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("phoenix-twin"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Phoenix UI"));

    spyFetch.mockRestore();
    logSpy.mockRestore();
  });

  it("should execute query command with --compact and --json", async () => {
    const mockSpans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "t-mock",
        name: "agent_turn",
        span_kind: "AGENT",
        status_code: "OK",
        attributes: { "session.id": "test-thread-id", "agent.name": "phoenix-twin" },
      }),
    ];

    const spyFetch = mockThread(mockSpans);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["query", "test-thread-id", "--compact", "--json"]);
    expect(code).toBe(0);
    const output = logSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.thread_id).toBe("test-thread-id");
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].agent).toBe("phoenix-twin");

    spyFetch.mockRestore();
    logSpy.mockRestore();
  });

  it("should execute query command with --flat and emit single-line JSON", async () => {
    const mockSpans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "t-mock",
        name: "agent_turn",
        span_kind: "AGENT",
        status_code: "OK",
        attributes: { "session.id": "test-flat-id", "agent.name": "phoenix-twin" },
      }),
    ];

    const spyFetch = mockThread(mockSpans);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["query", "test-flat-id", "--compact", "--json", "--flat"]);
    expect(code).toBe(0);
    const output = logSpy.mock.calls[0][0];
    expect(output).not.toContain("\n");
    const parsed = JSON.parse(output);
    expect(parsed.thread_id).toBe("test-flat-id");

    spyFetch.mockRestore();
    logSpy.mockRestore();
  });

  it("should auto-infer --json and --compact when only --flat is passed", async () => {
    const mockSpans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "t-mock",
        name: "agent_turn",
        span_kind: "AGENT",
        status_code: "OK",
        attributes: { "session.id": "test-flat-auto-id", "agent.name": "phoenix-twin" },
      }),
    ];

    const spyFetch = mockThread(mockSpans);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Neither --json nor --compact is explicitly passed
    const code = await main(["query", "test-flat-auto-id", "--failures", "--flat"]);
    expect(code).toBe(0);
    const output = logSpy.mock.calls[0][0];
    expect(output).not.toContain("\n");
    const parsed = JSON.parse(output);
    expect(parsed.thread_id).toBe("test-flat-auto-id");
    expect(parsed.filtered_turns).toBe(0);

    spyFetch.mockRestore();
    logSpy.mockRestore();
  });

  it("should execute diff command with --flat and output structured diff JSON", async () => {
    const mockSpans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "trace-turn-1",
        name: "agent_turn",
        span_kind: "AGENT",
        status_code: "OK",
        attributes: { "session.id": "test-diff-thread", "agent.name": "agent-1", "llm.model": "gpt-4" },
      }),
      new SpanNode({
        span_id: "s2",
        trace_id: "trace-turn-2",
        name: "agent_turn",
        span_kind: "AGENT",
        status_code: "OK",
        attributes: { "session.id": "test-diff-thread", "agent.name": "agent-2", "llm.model": "claude-3" },
      }),
    ];

    const spyFetch = mockThread(mockSpans);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["diff", "test-diff-thread#1", "test-diff-thread#2", "--flat"]);
    expect(code).toBe(0);
    const output = logSpy.mock.calls[0][0];
    expect(output).not.toContain("\n");

    const parsed = JSON.parse(output);
    expect(parsed.diff).toBeDefined();
    expect(parsed.diff.model.a).toBe("gpt-4");
    expect(parsed.diff.model.b).toBe("claude-3");
    expect(parsed.diff.model.changed).toBe(true);

    spyFetch.mockRestore();
    logSpy.mockRestore();
  });

  it("should execute context command with --budget and --flat", async () => {
    const mockSpans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "trace-ctx-1",
        name: "agent_turn",
        span_kind: "AGENT",
        status_code: "OK",
        attributes: {
          "session.id": "test-ctx-thread",
          "agent.name": "phoenix-twin",
          "input.value": "Explain quantum computing",
          "output.value": "Quantum computing uses qubits",
        },
      }),
    ];

    const spyFetch = mockThread(mockSpans);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["context", "test-ctx-thread", "--budget", "200", "--flat"]);
    expect(code).toBe(0);
    const output = logSpy.mock.calls[0][0];
    expect(output).not.toContain("\n");

    const parsed = JSON.parse(output);
    expect(parsed.thread_id).toBe("test-ctx-thread");
    expect(parsed.budget).toBe(200);
    expect(parsed.actual_tokens).toBeLessThanOrEqual(200);
    expect(parsed.root_intent).toContain("quantum computing");

    spyFetch.mockRestore();
    logSpy.mockRestore();
  });
});
