/**
 * Phoenix's SQLite stores times as naive UTC (`2026-11-08 01:13:33.096000`, no `Z`). JavaScript reads such a string as
 * local time, so on any machine that is not on UTC every absolute time was off by the machine's offset (7 hours on the
 * ba run's machine) while durations, which subtract two shifted times, looked fine. It showed up when the spans were
 * compared with the relay's clock. These tests run in a zone that is not UTC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoenixDBClient } from "../src/clients/phoenix-db.js";
import { SpanNode } from "../src/models.js";
import { type Fixture, makePhoenixDb } from "./helpers/phoenix-db-fixture.js";

const span = (start: string, end: string) => new SpanNode({ span_id: "s", trace_id: "t", name: "x", start_time: start, end_time: end });

describe.each(["Asia/Ho_Chi_Minh", "America/Los_Angeles", "UTC"])("span times in zone %s", (zone) => {
  beforeEach(() => {
    vi.stubEnv("TZ", zone);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads Phoenix's naive timestamps, with a space or a T, as UTC", () => {
    expect(span("2026-11-08 01:13:33.096000", "2026-11-08 01:13:34.391000").startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
    expect(span("2026-11-08T01:13:33.096000", "2026-11-08T01:13:34.391000").endTime?.toISOString()).toBe("2026-11-08T01:13:34.391Z");
    expect(span("2026-11-08 01:13:33", "2026-11-08 01:13:35").startTime?.toISOString()).toBe("2026-11-08T01:13:33.000Z");
  });

  it("keeps a time that names its zone", () => {
    expect(span("2026-11-08T01:13:33.096Z", "2026-11-08T01:13:34Z").startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
    expect(span("2026-11-08T08:13:33.096+07:00", "2026-11-08T08:13:34+07:00").startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
    expect(span("2026-11-08T08:13:33.096+0700", "2026-11-08T08:13:34+0700").startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
  });

  it("keeps the duration", () => {
    expect(span("2026-11-08 01:13:33.096000", "2026-11-08 01:13:34.391000").durationMs).toBe(1295);
  });
});

describe("spans read from the SQLite file", () => {
  let fx: Fixture;
  beforeEach(() => {
    vi.stubEnv("TZ", "Asia/Ho_Chi_Minh");
    fx = makePhoenixDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fx.cleanup();
  });

  it("carry UTC times whatever the machine's zone", () => {
    const [first] = new PhoenixDBClient(fx.dbPath).getSpansForThread("S-OLD");
    expect(first.startTime?.toISOString()).toBe("2026-11-08T07:00:00.000Z");
  });
});
