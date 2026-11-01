/**
 * Empirical Benchmark & Invariant Verification for buzz-trace Causal Graph
 */
import { describe, it, expect } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { SpanNode } from "../src/models.js";

interface BenchmarkResult {
  numTurns: number;
  numEdges: number;
  skewRangeMs: [number, number];
  elapsedMs: number;
  causalInversions: number;
  clockSkewAnomaliesDetected: number;
  branchCount: number;
}

function runEmpiricalTest(numAgents: number, maxSkewMs: number): BenchmarkResult {
  const spans: SpanNode[] = [];
  const eventIds: string[] = [];

  // Root turn
  const rootId = "ev-0";
  eventIds.push(rootId);
  spans.push(
    new SpanNode({
      span_id: "s-0",
      trace_id: "tr-0",
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: new Date(1700000000000).toISOString(),
      end_time: new Date(1700000005000).toISOString(),
      status_code: "OK",
      attributes: {
        "session.id": "benchmark-session",
        "agent.name": "agent-root",
        "nostr.event_id": rootId,
      },
    }),
  );

  let edgeCount = 0;

  // Build random multi-agent DAG (arborescence) with injected severe clock skews
  for (let i = 1; i < numAgents; i++) {
    const eventId = `ev-${i}`;
    eventIds.push(eventId);

    const parentIdx = Math.floor(Math.random() * i);
    const parentEventId = eventIds[parentIdx];
    edgeCount++;

    const skew = Math.floor((Math.random() * 2 - 1) * maxSkewMs);
    const baseTime = 1700000000000 + i * 1000 + skew;
    const duration = 500 + Math.floor(Math.random() * 2000);

    spans.push(
      new SpanNode({
        span_id: `s-${i}`,
        trace_id: `tr-${i}`,
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: new Date(baseTime).toISOString(),
        end_time: new Date(baseTime + duration).toISOString(),
        status_code: "OK",
        attributes: {
          "session.id": "benchmark-session",
          "agent.name": `agent-${i}`,
          "nostr.event_id": eventId,
          "nostr.reply_to": parentEventId,
        },
      }),
    );
  }

  // Shuffle spans to simulate arbitrary arrival order in telemetry collection
  for (let i = spans.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [spans[i], spans[j]] = [spans[j], spans[i]];
  }

  const startPerf = performance.now();
  const agg = new ThreadAggregator("benchmark-thread", "mobile");
  const telemetry = agg.aggregate(spans);
  const elapsedMs = performance.now() - startPerf;

  // Invariant 1: For every causal edge (u -> v), turnIndex(u) < turnIndex(v)
  let causalInversions = 0;
  for (const edge of telemetry.dag?.edges || []) {
    if (edge.fromTurnIndex >= edge.toTurnIndex) {
      causalInversions++;
    }
  }

  const clockSkewAnomalies = telemetry.anomalies.filter((a) => a.type === "CLOCK_SKEW").length;
  const branchCount = telemetry.dag?.branches.length || 0;

  return {
    numTurns: telemetry.turns.length,
    numEdges: edgeCount,
    skewRangeMs: [-maxSkewMs, maxSkewMs],
    elapsedMs,
    causalInversions,
    clockSkewAnomaliesDetected: clockSkewAnomalies,
    branchCount,
  };
}

describe("Empirical Invariant Verification & Scalability", () => {
  const scales = [10, 50, 100, 200];

  for (const scale of scales) {
    it(`verifies 0 causal inversions across ${scale} turns under ±5000ms clock skew`, () => {
      const res = runEmpiricalTest(scale, 5000);

      // Print empirical metric
      console.log(
        `[Scale ${res.numTurns.toString().padStart(3)}] ` +
          `Edges: ${res.numEdges.toString().padStart(3)} | ` +
          `Latency: ${res.elapsedMs.toFixed(2).padStart(6)}ms | ` +
          `Inversions: ${res.causalInversions} | ` +
          `Skew Anomalies: ${res.clockSkewAnomaliesDetected.toString().padStart(3)} | ` +
          `Branches: ${res.branchCount}`,
      );

      // Strict mathematical invariants
      expect(res.numTurns).toBe(scale);
      expect(res.causalInversions).toBe(0); // MUST HAVE ZERO CAUSAL INVERSIONS
      expect(res.elapsedMs).toBeLessThan(100); // Efficient topological sort O(V + E)
    });
  }
});
