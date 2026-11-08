/**
 * Links into the Phoenix web UI. Phoenix 21 routes a project by its global id (`UHJvamVjdDoz` is `Project:3`), not by its
 * name, and knows no `selectedSessionId` parameter, so `/projects/<name>/sessions?selectedSessionId=…` opened nothing.
 * The routes that need no project id are `/redirects/sessions/<session_id>` and `/redirects/traces/<trace_id>`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchThreadTelemetry } from "../src/cli.js";
import { Config } from "../src/config.js";
import { SpanNode } from "../src/models.js";
import { mockThread } from "./helpers/mock-phoenix.js";

const config = new Config({ uiEndpoint: "http://phoenix.test:6006/", project: "ba" });

describe("Phoenix UI links", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a whole thread through the redirect that finds the session by its id", () => {
    expect(config.getSessionUrl("b48126c5", "ignored")).toBe("http://phoenix.test:6006/redirects/sessions/b48126c5");
  });

  it("falls back to the thread id when the spans name no session", () => {
    expect(config.getSessionUrl(null, "thread-1")).toBe("http://phoenix.test:6006/redirects/sessions/thread-1");
  });

  it("opens one turn's trace through the redirect that finds the trace by its id", () => {
    expect(config.getTraceUrl("1baae792ac99c2f04297bbeb4960e14e")).toBe("http://phoenix.test:6006/redirects/traces/1baae792ac99c2f04297bbeb4960e14e");
  });

  it("never puts the project name where Phoenix wants a global id", () => {
    expect(config.getSessionUrl("s")).not.toContain("/projects/");
    expect(config.getTraceUrl("t")).not.toContain("/projects/");
    expect(config.getSessionUrl("s")).not.toContain("selectedSessionId");
  });

  it("escapes what is not safe in a path", () => {
    expect(config.getTraceUrl("a b/c")).toBe("http://phoenix.test:6006/redirects/traces/a%20b%2Fc");
  });

  it("puts the links on the thread and on every turn", async () => {
    const span = new SpanNode({ span_id: "s1", trace_id: "trace-1", name: "agent_turn", span_kind: "AGENT", parent_id: null, attributes: { "session.id": "sess-1", "agent.name": "a" } });
    mockThread([span]);
    const t = await fetchThreadTelemetry(new Config({ endpoint: "http://phoenix.test:6006", project: "ba" }), "sess-1");
    expect(t.phoenixSessionUrl).toBe("http://phoenix.test:6006/redirects/sessions/sess-1");
    expect(t.turns[0].traceUrl).toBe("http://phoenix.test:6006/redirects/traces/trace-1");
  });
});

describe("the test machine", () => {
  it("is empty: no developer variables, no home of the developer", async () => {
    const os = await import("node:os");
    expect(os.homedir()).toContain("buzz-trace-home-");
    for (const name of ["PHOENIX_URL", "PHOENIX_ENDPOINT", "PHOENIX_PROJECT", "PHOENIX_API_KEY", "PHOENIX_EMAIL", "PHOENIX_PASSWORD"]) {
      expect(process.env[name], name).toBeUndefined();
    }
  });
});
