/**
 * Every time of a span must be the same instant on every machine. Phoenix's API names the zone of each time
 * (`2026-11-08T01:13:33.096000+00:00`); a time that does not is read as UTC, because JavaScript would read it as the
 * machine's local time, off by the machine's offset (7 hours on the ba run's machine) while durations, which subtract two
 * shifted times, looked fine. These tests run in zones that are not UTC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoenixClient } from "../src/clients/phoenix-api.js";
import { SpanNode } from "../src/models.js";
import { FakePhoenix, restSpan } from "./helpers/fake-phoenix.js";

const span = (start: string, end: string) => new SpanNode({ span_id: "s", trace_id: "t", name: "x", start_time: start, end_time: end });

describe.each(["Asia/Ho_Chi_Minh", "America/Los_Angeles", "UTC"])("span times in zone %s", (zone) => {
  beforeEach(() => {
    vi.stubEnv("TZ", zone);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps a time that names its zone, as Phoenix's API gives it", () => {
    expect(span("2026-11-08T01:13:33.096000+00:00", "2026-11-08T01:13:34.391000+00:00").startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
    expect(span("2026-11-08T01:13:33.096Z", "2026-11-08T01:13:34Z").startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
    expect(span("2026-11-08T08:13:33.096+07:00", "2026-11-08T08:13:34+07:00").startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
    expect(span("2026-11-08T08:13:33.096+0700", "2026-11-08T08:13:34+0700").startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
  });

  it("reads a time without a zone as UTC, never as the machine's local time", () => {
    expect(span("2026-11-08 01:13:33.096000", "2026-11-08 01:13:34.391000").startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
    expect(span("2026-11-08T01:13:33.096000", "2026-11-08T01:13:34.391000").endTime?.toISOString()).toBe("2026-11-08T01:13:34.391Z");
    expect(span("2026-11-08 01:13:33", "2026-11-08 01:13:35").startTime?.toISOString()).toBe("2026-11-08T01:13:33.000Z");
  });

  it("keeps the duration", () => {
    expect(span("2026-11-08T01:13:33.096000+00:00", "2026-11-08T01:13:34.391000+00:00").durationMs).toBe(1295);
  });

  it("gives the spans and events read from Phoenix the same UTC instants", async () => {
    const fake = new FakePhoenix().install();
    fake.sessions.push({ session_id: "S-1", project: "ba" });
    fake.spans.push(
      restSpan({
        trace: "t".repeat(32),
        name: "agent_turn",
        start: "2026-11-08T01:13:33.096000+00:00",
        end: "2026-11-08T01:13:34.391000+00:00",
        attributes: { "session.id": "S-1" },
        events: [{ name: "steer", timestamp: "2026-11-08T01:13:33.500000+00:00", attributes: {} }],
      }),
    );
    const { spans } = await new PhoenixClient("http://phoenix.test:6006", 5000).locateThread("S-1", "ba");
    expect(spans[0].startTime?.toISOString()).toBe("2026-11-08T01:13:33.096Z");
    expect(spans[0].endTime?.toISOString()).toBe("2026-11-08T01:13:34.391Z");
    expect(spans[0].events[0].time?.toISOString()).toBe("2026-11-08T01:13:33.500Z");
  });
});
