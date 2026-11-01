import { describe, it, expect, vi, beforeEach } from "vitest";
import { PhoenixClient } from "../src/clients/phoenix-api.js";
import { SpanNode } from "../src/models.js";

describe("PhoenixClient Multi-Identifier Resolution", () => {
  let client: PhoenixClient;

  beforeEach(() => {
    client = new PhoenixClient("http://127.0.0.1:6006");
  });

  it("resolves full thread session when given a 32-hex Trace ID", async () => {
    const traceId = "1196032a3d6f12e915a6fa7226a4041c";
    const sessionId = "4e1899a0855358de0675f06861a6cd5a4b9398228c05e9172cce1c18769487c0";

    const mockTraceSpans = [
      new SpanNode({
        span_id: "s1",
        trace_id: traceId,
        name: "agent_turn",
        parent_id: null,
        attributes: { "session.id": sessionId },
      }),
    ];

    const mockSessionSpans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "t1",
        name: "agent_turn",
        parent_id: null,
        attributes: { "session.id": sessionId },
      }),
      new SpanNode({
        span_id: "s2",
        trace_id: "t2",
        name: "agent_turn",
        parent_id: null,
        attributes: { "session.id": sessionId },
      }),
    ];

    vi.spyOn(client, "getSpansByTraceId").mockResolvedValue(mockTraceSpans);
    vi.spyOn(client, "getSpansByAttribute").mockImplementation(async (_project, key, val) => {
      if (key === "session.id" && val === sessionId) {
        return mockSessionSpans;
      }
      return [];
    });

    const spans = await client.getSpansForThread("mobile", traceId);
    expect(spans.length).toBeGreaterThan(0);
    expect(client.getSpansByTraceId).toHaveBeenCalledWith("mobile", traceId);
    expect(client.getSpansByAttribute).toHaveBeenCalledWith("mobile", "session.id", sessionId);
  });

  it("resolves full thread when given a 64-hex Nostr Thread Root ID", async () => {
    const threadRootId = "4e1899a0855358de0675f06861a6cd5a4b9398228c05e9172cce1c18769487c0";

    const mockRootSpans = [
      new SpanNode({
        span_id: "s1",
        trace_id: "t1",
        name: "agent_turn",
        attributes: { "session.id": threadRootId },
      }),
    ];

    vi.spyOn(client, "getSpansByAttribute").mockImplementation(async (_project, key, val) => {
      if (key === "session.id" && val === threadRootId) {
        return mockRootSpans as any;
      }
      return [];
    });
    vi.spyOn(client, "getSpansByTraceId").mockResolvedValue(mockRootSpans as any);

    const spans = await client.getSpansForThread("mobile", threadRootId);
    expect(spans.length).toBe(1);
    expect(client.getSpansByAttribute).toHaveBeenCalledWith("mobile", "session.id", threadRootId);
  });
});
