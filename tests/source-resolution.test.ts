/**
 * Where a thread's telemetry comes from, and what the CLI says when it cannot be had: a thread that is nowhere is
 * NOT_FOUND and says where it looked; a Phoenix that refused the request is an error, never a "not found".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchThreadTelemetry, main } from "../src/cli.js";
import { PhoenixAPIError, PhoenixClient } from "../src/clients/phoenix-api.js";
import { Config } from "../src/config.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { SpanNode } from "../src/models.js";
import { mockThread } from "./helpers/mock-phoenix.js";

const turn = () =>
  new SpanNode({ span_id: "s1", trace_id: "t1", name: "agent_turn", span_kind: "AGENT", parent_id: null, attributes: { "session.id": "S-NEW", "agent.name": "paul" } });
const config = new Config({ endpoint: "http://phoenix.test:6006", project: "ba" });

describe("thread source resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("names the Phoenix a found thread was read from, and the project it is in", async () => {
    mockThread([turn()], "ba");
    const telemetry = await fetchThreadTelemetry(new Config({ endpoint: "http://phoenix.test:6006" }), "S-NEW");
    expect(telemetry.totalTurns).toBe(1);
    expect(telemetry.source).toBe("http://phoenix.test:6006");
    expect(telemetry.project).toBe("ba");
  });

  it("says where it looked when the thread is not in Phoenix", async () => {
    mockThread([]);
    const telemetry = await fetchThreadTelemetry(config, "no-such-thread");
    expect(telemetry.status).toBe("NOT_FOUND");
    expect(telemetry.sourcesTried).toEqual(["http://phoenix.test:6006: no spans for it"]);
    const compact = JSON.parse(new JsonRenderer().render(telemetry, { compact: true, flat: true }));
    expect(compact.status).toBe("NOT_FOUND");
    expect(compact.tried).toEqual(telemetry.sourcesTried);
  });

  it("names every project it looked in, and where the thread is if it is elsewhere", async () => {
    vi.spyOn(PhoenixClient.prototype, "locateThread").mockResolvedValue({ project: null, spans: [], searched: ["ba", "mobile"], note: "the session exists in project default" });
    const telemetry = await fetchThreadTelemetry(new Config({ endpoint: "http://phoenix.test:6006" }), "no-such-thread");
    expect(telemetry.sourcesTried).toEqual(["http://phoenix.test:6006: no spans for it (looked in projects ba, mobile); the session exists in project default"]);
  });

  it("fails with a reason, not NOT_FOUND, when Phoenix refuses the request", async () => {
    vi.spyOn(PhoenixClient.prototype, "locateThread").mockRejectedValue(
      new PhoenixAPIError("HTTP 401 Unauthorized: Phoenix authentication is on, set PHOENIX_API_KEY", 401),
    );
    await expect(fetchThreadTelemetry(config, "no-such-thread")).rejects.toThrow(/PHOENIX_API_KEY/);
    await expect(fetchThreadTelemetry(config, "no-such-thread")).rejects.toThrow(/phoenix\.test:6006/);
  });

  it("the CLI exits 2 and prints the reason when Phoenix cannot be queried", async () => {
    vi.stubEnv("PHOENIX_URL", "http://phoenix.test:6006");
    vi.spyOn(PhoenixClient.prototype, "locateThread").mockRejectedValue(new PhoenixAPIError("HTTP 401 Unauthorized", 401));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await main(["query", "no-such-thread", "--project", "ba", "--compact", "--json"]);
    expect(code).toBe(2);
    expect(String(err.mock.calls[0][0])).toContain("401");
  });
});

describe("Phoenix API key", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const stubFetch = (status: number, body: unknown = { data: [] }) => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url: String(url), headers: init?.headers ?? {} });
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      }),
    );
    return calls;
  };

  it("sends the key as a Bearer token", async () => {
    const calls = stubFetch(200);
    await new PhoenixClient("http://phoenix.test:6006", 1000, "k-123").listProjects();
    expect(calls[0].headers.Authorization).toBe("Bearer k-123");
  });

  it("sends no Authorization header when there is no key", async () => {
    const calls = stubFetch(200);
    await new PhoenixClient("http://phoenix.test:6006", 1000).listProjects();
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("says authentication is on, and what to set, when Phoenix answers 401 or 403", async () => {
    for (const status of [401, 403]) {
      stubFetch(status, "Invalid token");
      const error = await new PhoenixClient("http://phoenix.test:6006", 1000).listProjects().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PhoenixAPIError);
      expect((error as PhoenixAPIError).statusCode).toBe(status);
      expect((error as PhoenixAPIError).message).toMatch(/PHOENIX_API_KEY/);
      expect((error as PhoenixAPIError).message).toMatch(/PHOENIX_EMAIL and PHOENIX_PASSWORD/);
    }
  });

  it("reads the key from --api-key or PHOENIX_API_KEY, and never prints it", () => {
    vi.stubEnv("PHOENIX_API_KEY", "from-env");
    expect(new Config().apiKey).toBe("from-env");
    expect(new Config({ apiKey: "from-flag" }).apiKey).toBe("from-flag");
    expect(JSON.stringify(new Config({ apiKey: "from-flag" }))).not.toContain("from-flag");
  });
});
