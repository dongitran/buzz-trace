/** Stands in for the live Phoenix in tests that are about something else: the client finds `spans` (in `project`) for any thread. */
import { vi } from "vitest";
import { PhoenixClient } from "../../src/clients/phoenix-api.js";
import type { SpanNode } from "../../src/models.js";

export function mockThread(spans: SpanNode[], project: string | null = null) {
  return vi.spyOn(PhoenixClient.prototype, "locateThread").mockResolvedValue({ project, spans, searched: project ? [project] : [] });
}
