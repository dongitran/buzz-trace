/**
 * Where buzz-trace reads from, and with which credentials. Phoenix's server is the only source: the endpoint comes from
 * --endpoint, PHOENIX_ENDPOINT or PHOENIX_URL, and the project is found from the thread unless one is named. Credentials
 * never show up when a Config is printed or serialized.
 */
import * as util from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the endpoint", () => {
  it("is http://localhost:6006 when nothing says otherwise", () => {
    expect(new Config().endpoint).toBe("http://localhost:6006");
  });

  it("comes from --endpoint, then PHOENIX_ENDPOINT, then PHOENIX_URL", () => {
    vi.stubEnv("PHOENIX_URL", "http://from-url:6006");
    expect(new Config().endpoint).toBe("http://from-url:6006");
    vi.stubEnv("PHOENIX_ENDPOINT", "http://from-endpoint:6006");
    expect(new Config().endpoint).toBe("http://from-endpoint:6006");
    expect(new Config({ endpoint: "http://from-flag:6006" }).endpoint).toBe("http://from-flag:6006");
  });

  it("still takes PHOENIX_COLLECTOR_ENDPOINT, after the others", () => {
    vi.stubEnv("PHOENIX_COLLECTOR_ENDPOINT", "http://collector:6006");
    expect(new Config().endpoint).toBe("http://collector:6006");
    vi.stubEnv("PHOENIX_URL", "http://from-url:6006");
    expect(new Config().endpoint).toBe("http://from-url:6006");
  });

  it("loses a trailing slash and a /v1 suffix, and links the UI at the same place unless told otherwise", () => {
    expect(new Config({ endpoint: "http://phoenix.example.com/v1/" }).endpoint).toBe("http://phoenix.example.com");
    expect(new Config({ endpoint: "http://phoenix.example.com" }).uiEndpoint).toBe("http://phoenix.example.com");
    expect(new Config({ endpoint: "http://a", uiEndpoint: "http://ui/" }).uiEndpoint).toBe("http://ui");
  });
});

describe("the project", () => {
  it("is not decided here: with no --project and no PHOENIX_PROJECT it is null, and buzz-trace finds it from the thread", () => {
    expect(new Config().project).toBeNull();
  });

  it("comes from --project, then PHOENIX_PROJECT", () => {
    vi.stubEnv("PHOENIX_PROJECT", "from-env");
    expect(new Config().project).toBe("from-env");
    expect(new Config({ project: "from-flag" }).project).toBe("from-flag");
  });
});

describe("credentials", () => {
  it("come from --api-key or PHOENIX_API_KEY, and PHOENIX_EMAIL with PHOENIX_PASSWORD", () => {
    vi.stubEnv("PHOENIX_API_KEY", "key-from-env");
    vi.stubEnv("PHOENIX_EMAIL", "me@example.test");
    vi.stubEnv("PHOENIX_PASSWORD", "password-from-env");
    expect(new Config().credentials()).toEqual({ apiKey: "key-from-env", email: "me@example.test", password: "password-from-env" });
    expect(new Config({ apiKey: "key-from-flag" }).credentials().apiKey).toBe("key-from-flag");
  });

  it("are null when not set", () => {
    expect(new Config().credentials()).toEqual({ apiKey: null, email: null, password: null });
  });

  it("are not part of what a Config prints, logs or serializes", () => {
    vi.stubEnv("PHOENIX_EMAIL", "me@example.test");
    vi.stubEnv("PHOENIX_PASSWORD", "password-from-env");
    const config = new Config({ apiKey: "key-from-flag" });
    for (const text of [JSON.stringify(config), util.inspect(config, { depth: 6, showHidden: false }), String(config), JSON.stringify({ ...config })]) {
      for (const secret of ["key-from-flag", "me@example.test", "password-from-env"]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
