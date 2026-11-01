import { describe, it, expect, vi } from "vitest";
import { main } from "../src/cli.js";
import { PhoenixClient } from "../src/clients/phoenix-api.js";
import { SpanNode } from "../src/models.js";

describe("CLI", () => {
  it("should output version on --version", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["--version"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("buzz-trace 0.1.1"));
    logSpy.mockRestore();
  });

  it("should show help when no command is provided", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main([]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("USAGE:"));
    logSpy.mockRestore();
  });

  it("should execute inspect command with mock spans", async () => {
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

    const spyFetch = vi.spyOn(PhoenixClient.prototype, "getSpansForThread").mockResolvedValue(mockSpans);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await main(["inspect", "test-thread-id", "--no-color"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("test-thread-id"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("phoenix-twin"));

    spyFetch.mockRestore();
    logSpy.mockRestore();
  });
});
