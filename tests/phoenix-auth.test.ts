/**
 * How buzz-trace signs in to a Phoenix that has authentication on. An API key goes first (Bearer). Without one it signs in
 * with PHOENIX_EMAIL and PHOENIX_PASSWORD (POST /auth/login, Bearer with the access token it sets) and, when a request is
 * refused, refreshes the session or signs in again. No credential is ever printed, put in a URL, or kept in an error. Every
 * credential in these tests is fake.
 */
import * as util from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoenixAPIError, PhoenixClient } from "../src/clients/phoenix-api.js";
import { FakePhoenix } from "./helpers/fake-phoenix.js";

const API_KEY = "fake-api-key-AAAA1111bbbb";
const EMAIL = "someone@example.test";
const PASSWORD = "fake-pass-word-ZZZZ9999!";
const SECRETS = [API_KEY, PASSWORD];

let fake: FakePhoenix;
beforeEach(() => {
  fake = new FakePhoenix().install();
  fake.requireAuth = true;
  fake.apiKeys.add(API_KEY);
  fake.users.set(EMAIL, PASSWORD);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const make = (credentials: ConstructorParameters<typeof PhoenixClient>[2]) => new PhoenixClient("http://phoenix.test:6006", 5000, credentials);
const bearer = (call: { headers: Record<string, string> }) => call.headers.authorization;

describe("an API key", () => {
  it("is sent as a Bearer token on every request, and nothing signs in", async () => {
    const client = make({ apiKey: API_KEY });
    await client.listProjects();
    await client.getSession("nothing");
    expect(fake.of(/^\/v1\//).map(bearer)).toEqual([`Bearer ${API_KEY}`, `Bearer ${API_KEY}`]);
    expect(fake.count("POST", "/auth/login")).toBe(0);
  });

  it("still works as a plain string, the way earlier versions took it", async () => {
    await make(API_KEY).listProjects();
    expect(bearer(fake.calls[0])).toBe(`Bearer ${API_KEY}`);
  });

  it("goes before an email and a password: no sign-in while the key works", async () => {
    await make({ apiKey: API_KEY, email: EMAIL, password: PASSWORD }).listProjects();
    expect(fake.count("POST", "/auth/login")).toBe(0);
    expect(bearer(fake.calls[0])).toBe(`Bearer ${API_KEY}`);
  });

  it("is never put in the URL", async () => {
    await make({ apiKey: API_KEY }).listProjects();
    expect(fake.calls.some((c) => `${c.path}?${c.query}`.includes(API_KEY))).toBe(false);
  });

  it("when refused, gives way to the email and password if there are any", async () => {
    fake.apiKeys.clear();
    const client = make({ apiKey: API_KEY, email: EMAIL, password: PASSWORD });
    await expect(client.listProjects()).resolves.toHaveLength(2);
    await client.listProjects();
    expect(fake.count("POST", "/auth/login")).toBe(1);
    expect(bearer(fake.of("/v1/projects").at(-1)!)).toBe("Bearer access-1");
  });

  it("when refused and alone, fails with what to set, naming no credential", async () => {
    fake.apiKeys.clear();
    const error = await make({ apiKey: API_KEY }).listProjects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhoenixAPIError);
    expect((error as PhoenixAPIError).statusCode).toBe(401);
    const message = (error as PhoenixAPIError).message;
    expect(message).toMatch(/rejected the API key/);
    for (const name of ["PHOENIX_API_KEY", "PHOENIX_EMAIL", "PHOENIX_PASSWORD"]) {
      expect(message).toContain(name);
    }
    for (const secret of SECRETS) {
      expect(message).not.toContain(secret);
    }
  });
});

describe("an email and a password", () => {
  it("sign in once, then every request carries the access token the sign-in set", async () => {
    const client = make({ email: EMAIL, password: PASSWORD });
    await client.listProjects();
    await client.listProjects();
    expect(fake.count("POST", "/auth/login")).toBe(1);
    expect(fake.of("/auth/login")[0].body).toEqual({ email: EMAIL, password: PASSWORD });
    expect(fake.of("/v1/projects").map(bearer)).toEqual(["Bearer access-1", "Bearer access-1"]);
  });

  it("send nothing but the sign-in itself before they have signed in", async () => {
    await make({ email: EMAIL, password: PASSWORD }).listProjects();
    expect(fake.calls[0].path).toBe("/auth/login");
    expect(fake.calls[0].headers.authorization).toBeUndefined();
  });

  it("refresh the session when an access token has expired, and carry on with the new one", async () => {
    const client = make({ email: EMAIL, password: PASSWORD });
    await client.listProjects();
    fake.expireAccessTokens();
    await expect(client.listProjects()).resolves.toHaveLength(2);
    expect(fake.count("POST", "/auth/refresh")).toBe(1);
    expect(fake.of("/auth/refresh")[0].headers.cookie).toContain("phoenix-refresh-token=refresh-1");
    expect(fake.count("POST", "/auth/login")).toBe(1);
    expect(bearer(fake.of("/v1/projects").at(-1)!)).toBe("Bearer access-2");
    // The refresh token is rotated: the next refresh uses the new one.
    fake.expireAccessTokens();
    await client.listProjects();
    expect(fake.of("/auth/refresh")[1].headers.cookie).toContain("phoenix-refresh-token=refresh-2");
  });

  it("sign in again when the refresh is refused too", async () => {
    const client = make({ email: EMAIL, password: PASSWORD });
    await client.listProjects();
    fake.expireAccessTokens();
    fake.refreshTokens.clear();
    await expect(client.listProjects()).resolves.toHaveLength(2);
    expect(fake.count("POST", "/auth/refresh")).toBe(1);
    expect(fake.count("POST", "/auth/login")).toBe(2);
  });

  it("do not retry for ever: a request refused after a fresh sign-in fails", async () => {
    const client = make({ email: EMAIL, password: PASSWORD });
    fake.failWith = (call) => (call.path.startsWith("/v1/") ? new Response("nope", { status: 401 }) : null);
    await expect(client.listProjects()).rejects.toMatchObject({ statusCode: 401 });
    expect(fake.count("POST", "/auth/login")).toBeLessThanOrEqual(2);
    expect(fake.of("/v1/projects").length).toBeLessThanOrEqual(2);
  });

  it("a wrong password is said to be wrong, without the password or the email", async () => {
    const error = await make({ email: EMAIL, password: "wrong-password-QQQQ" }).listProjects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhoenixAPIError);
    expect((error as PhoenixAPIError).statusCode).toBe(401);
    expect((error as PhoenixAPIError).message).toMatch(/PHOENIX_EMAIL and PHOENIX_PASSWORD/);
    expect((error as PhoenixAPIError).message).not.toContain("wrong-password-QQQQ");
    expect((error as PhoenixAPIError).message).not.toContain(EMAIL);
  });

  it("a rate-limited sign-in says so, and points to an API key", async () => {
    fake.loginRateLimited = true;
    const error = await make({ email: EMAIL, password: PASSWORD }).listProjects().catch((e: unknown) => e);
    expect((error as PhoenixAPIError).statusCode).toBe(429);
    expect((error as PhoenixAPIError).message).toMatch(/rate-limit/i);
    expect((error as PhoenixAPIError).message).toContain("30");
    expect((error as PhoenixAPIError).message).toContain("PHOENIX_API_KEY");
  });

  it("are not needed by a Phoenix with no sign-in route and no authentication", async () => {
    fake.requireAuth = false;
    fake.loginMissing = true;
    await expect(make({ email: EMAIL, password: PASSWORD }).listProjects()).resolves.toHaveLength(2);
    expect(fake.of("/v1/projects")[0].headers.authorization).toBeUndefined();
  });
});

describe("no credentials", () => {
  it("send no Authorization header to a Phoenix that is open", async () => {
    fake.requireAuth = false;
    await make(null).listProjects();
    expect(fake.calls[0].headers.authorization).toBeUndefined();
    expect(fake.count("POST", "/auth/login")).toBe(0);
  });

  it("fail with what to set when Phoenix asks for authentication, for a 403 as well", async () => {
    for (const status of [401, 403]) {
      fake.failWith = () => new Response("Invalid token", { status });
      const error = await make(null).listProjects().catch((e: unknown) => e);
      expect((error as PhoenixAPIError).statusCode).toBe(status);
      for (const name of ["PHOENIX_API_KEY", "PHOENIX_EMAIL", "PHOENIX_PASSWORD"]) {
        expect((error as PhoenixAPIError).message).toContain(name);
      }
    }
  });
});

describe("no credential is ever printed", () => {
  it("not in an error, even when the server's reply repeats it", async () => {
    const wrong = "wrong-pass-word-QQQQ7777";
    fake.errorBody = `rejected ${API_KEY} and ${wrong} for ${EMAIL}`;
    fake.apiKeys.clear();
    // What the client holds, it never repeats: a server cannot make it say them.
    const cases: Array<[Record<string, string>, string[]]> = [
      [{ apiKey: API_KEY }, [API_KEY, `Bearer ${API_KEY}`]],
      [{ email: EMAIL, password: wrong }, [wrong, EMAIL]],
      [{ apiKey: API_KEY, email: EMAIL, password: wrong }, [API_KEY, wrong, EMAIL, `Bearer ${API_KEY}`]],
    ];
    for (const [credentials, held] of cases) {
      const error = await make(credentials).listProjects().catch((e: unknown) => e);
      expect(error, JSON.stringify(Object.keys(credentials))).toBeInstanceOf(PhoenixAPIError);
      for (const secret of held) {
        expect((error as Error).message, JSON.stringify(Object.keys(credentials))).not.toContain(secret);
      }
    }
  });

  it("not in a server error, a network error, or an error that carries a token", async () => {
    const leaks = [`boom ${API_KEY}`, `boom ${PASSWORD}`, "boom Bearer eyJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJ4In0.c2lnbmF0dXJl"];
    for (const text of leaks) {
      fake.failWith = () => new Response(text, { status: 500 });
      const serverError = await make({ apiKey: API_KEY, password: PASSWORD }).listProjects().catch((e: unknown) => e);
      expect(String((serverError as Error).message)).not.toMatch(/fake-api-key-AAAA|fake-pass-word|eyJhbGci/);
      fake.failWith = () => {
        throw new TypeError(text);
      };
      const networkError = await make({ apiKey: API_KEY, password: PASSWORD }).listProjects().catch((e: unknown) => e);
      expect(String((networkError as Error).message)).not.toMatch(/fake-api-key-AAAA|fake-pass-word|eyJhbGci/);
    }
  });

  it("not in what a client prints when it is logged or serialized", () => {
    const client = make({ apiKey: API_KEY, email: EMAIL, password: PASSWORD });
    for (const text of [JSON.stringify(client), util.inspect(client, { depth: 6 }), String(client)]) {
      for (const secret of [...SECRETS, EMAIL]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("not on the console while it works", async () => {
    const out = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")].map((spy) => spy.mockImplementation(() => {}));
    await make({ email: EMAIL, password: PASSWORD }).listProjects();
    await make({ apiKey: API_KEY }).listProjects();
    for (const spy of out) {
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/fake-api-key-AAAA|fake-pass-word|access-1/);
    }
    vi.restoreAllMocks();
  });
});
