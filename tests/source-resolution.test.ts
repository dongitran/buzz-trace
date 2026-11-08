/**
 * Where a thread's telemetry comes from, and what the CLI says when it cannot be had: a thread that is nowhere is
 * NOT_FOUND and says where it looked; a Phoenix that refused the request is an error, never a "not found".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchThreadTelemetry, main } from "../src/cli.js";
import { PhoenixAPIError, PhoenixClient } from "../src/clients/phoenix-api.js";
import { Config } from "../src/config.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { type Fixture, makePhoenixDb } from "./helpers/phoenix-db-fixture.js";

describe("thread source resolution", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makePhoenixDb();
  });
  afterEach(() => {
    fx.cleanup();
    vi.restoreAllMocks();
  });

  it("names the database a found thread was read from", async () => {
    const config = new Config({ dbPath: fx.dbPath, project: "ba" });
    const telemetry = await fetchThreadTelemetry(config, "S-NEW");
    expect(telemetry.totalTurns).toBe(3);
    expect(telemetry.source).toBe(`sqlite:${fx.dbPath}`);
  });

  it("says where it looked when the thread is in neither the database nor Phoenix", async () => {
    vi.spyOn(PhoenixClient.prototype, "getSpansForThread").mockResolvedValue([]);
    const config = new Config({ dbPath: fx.dbPath, endpoint: "http://phoenix.test:6006", project: "ba" });
    const telemetry = await fetchThreadTelemetry(config, "no-such-thread");
    expect(telemetry.status).toBe("NOT_FOUND");
    expect(telemetry.sourcesTried).toHaveLength(2);
    expect(telemetry.sourcesTried[0]).toMatch(new RegExp(`^sqlite:${fx.dbPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} \\(written .*\\): no spans for it$`));
    expect(telemetry.sourcesTried[1]).toBe("http://phoenix.test:6006: no spans for it");
    const compact = JSON.parse(new JsonRenderer().render(telemetry, { compact: true, flat: true }));
    expect(compact.status).toBe("NOT_FOUND");
    expect(compact.tried).toEqual(telemetry.sourcesTried);
  });

  it("fails with a reason, not NOT_FOUND, when Phoenix refuses the request and the database has nothing", async () => {
    vi.spyOn(PhoenixClient.prototype, "getSpansForThread").mockRejectedValue(
      new PhoenixAPIError("HTTP 401 Unauthorized: Phoenix authentication is on, set PHOENIX_API_KEY", 401),
    );
    const config = new Config({ dbPath: fx.dbPath, endpoint: "http://phoenix.test:6006", project: "ba" });
    await expect(fetchThreadTelemetry(config, "no-such-thread")).rejects.toThrow(/PHOENIX_API_KEY/);
    await expect(fetchThreadTelemetry(config, "no-such-thread")).rejects.toThrow(/phoenix\.test:6006/);
  });

  it("the CLI exits 2 and prints the reason when Phoenix cannot be queried", async () => {
    vi.spyOn(PhoenixClient.prototype, "getSpansForThread").mockRejectedValue(new PhoenixAPIError("HTTP 401 Unauthorized", 401));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await main(["query", "no-such-thread", "--db", fx.dbPath, "--project", "ba", "--compact", "--json"]);
    expect(code).toBe(2);
    expect(String(err.mock.calls[0][0])).toContain("401");
  });

  it("a thread the database has is never sent to Phoenix", async () => {
    const api = vi.spyOn(PhoenixClient.prototype, "getSpansForThread").mockResolvedValue([]);
    const config = new Config({ dbPath: fx.dbPath, project: "ba" });
    await fetchThreadTelemetry(config, "S-OLD");
    expect(api).not.toHaveBeenCalled();
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
      expect((error as PhoenixAPIError).message).toMatch(/--db/);
    }
  });

  it("reads the key from --api-key or PHOENIX_API_KEY, and never prints it", () => {
    vi.stubEnv("PHOENIX_API_KEY", "from-env");
    expect(new Config().apiKey).toBe("from-env");
    expect(new Config({ apiKey: "from-flag" }).apiKey).toBe("from-flag");
    expect(JSON.stringify(new Config({ apiKey: "from-flag" }))).not.toContain("from-flag");
  });
});
