/**
 * Adversarial Chaos & Extreme Clock Skew Stress Test Suite
 *
 * Simulates real-world chaotic conditions across distributed multi-host agent networks:
 * - Scenario A: Extreme Clock Drift (±30,000ms to ±60,000ms offset from WSL2 VM resume after laptop sleep)
 * - Scenario B: Monotonic Jump & Negative Span Duration (start_time > end_time from NTP step adjustments)
 * - Scenario C: Orphaned Turn Flood (10 turns referencing non-existent reply_to IDs from dropped relay events)
 * - Scenario D: Interleaved Multi-Parent Cycles (directed telemetry cycle A -> B -> C -> A with branches)
 */

import { describe, it, expect } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { ThreadQueryEngine } from "../src/engine/query.js";
import { AnomalyDetector } from "../src/engine/analyzer.js";
import { SpanNode } from "../src/models.js";

describe("Adversarial Chaos & Extreme Clock Skew Stress Engine", () => {
  // Helper to build standardized agent turn spans
  function createTurnSpan(opts: {
    traceId: string;
    agentName: string;
    eventId: string;
    replyTo?: string | null;
    startTime: string;
    endTime?: string;
    statusCode?: string;
    statusMessage?: string;
    tools?: Array<{
      name: string;
      startTime?: string;
      endTime?: string;
      statusCode?: string;
    }>;
  }): SpanNode[] {
    const rootSpan = new SpanNode({
      span_id: `root-${opts.traceId}`,
      trace_id: opts.traceId,
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: opts.startTime,
      end_time: opts.endTime || opts.startTime,
      status_code: opts.statusCode || "OK",
      status_message: opts.statusMessage || null,
      attributes: {
        "session.id": "chaos-adversarial-session",
        "agent.name": opts.agentName,
        "nostr.event_id": opts.eventId,
        ...(opts.replyTo ? { "nostr.reply_to": opts.replyTo } : {}),
      },
    });

    const spans = [rootSpan];

    if (opts.tools) {
      for (let i = 0; i < opts.tools.length; i++) {
        const t = opts.tools[i];
        spans.push(
          new SpanNode({
            span_id: `tool-${opts.traceId}-${i}`,
            trace_id: opts.traceId,
            parent_id: rootSpan.spanId,
            name: `tool:${t.name}`,
            span_kind: "TOOL",
            start_time: t.startTime || opts.startTime,
            end_time: t.endTime || opts.endTime || opts.startTime,
            status_code: t.statusCode || "OK",
            attributes: {
              "tool.name": t.name,
              "input.value": "args",
            },
          }),
        );
      }
    }

    return spans;
  }

  /* -------------------------------------------------------------------------
   * Scenario A: Extreme Clock Drift (±30,000ms to ±60,000ms)
   * ------------------------------------------------------------------------- */
  describe("Scenario A: Extreme Clock Drift (±30,000ms to ±60,000ms WSL2 Resume)", () => {
    it("preserves strict causal topological sort across 5 chained agent turns with extreme clock jumps", () => {
      // Causal Chain:
      // Turn 1 (Lead on Host): T=12:00:00.000Z, dur=2s
      // Turn 2 (WSL2 Coder replying to Lead): T=11:59:15.000Z (-45,000ms clock lag on VM resume!), dur=3s
      // Turn 3 (Architect replying to Coder): T=12:00:30.000Z (+75,000ms leap forward!), dur=2s
      // Turn 4 (WSL2 Tester replying to Architect): T=11:59:30.000Z (-60,000ms clock lag, -90,000ms jump!), dur=4s
      // Turn 5 (Infra Reviewer replying to Tester): T=12:00:55.000Z (+55,000ms clock offset, +85,000ms jump!), dur=1s

      const spans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "tr-1",
          agentName: "host-lead",
          eventId: "ev-1",
          startTime: "2026-11-01T12:00:00.000Z",
          endTime: "2026-11-01T12:00:02.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-2",
          agentName: "wsl2-coder",
          eventId: "ev-2",
          replyTo: "ev-1",
          startTime: "2026-11-01T11:59:15.000Z", // -45,000ms clock skew vs parent start!
          endTime: "2026-11-01T11:59:18.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-3",
          agentName: "edge-architect",
          eventId: "ev-3",
          replyTo: "ev-2",
          startTime: "2026-11-01T12:00:30.000Z", // +75,000ms forward
          endTime: "2026-11-01T12:00:32.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-4",
          agentName: "wsl2-tester",
          eventId: "ev-4",
          replyTo: "ev-3",
          startTime: "2026-11-01T11:59:30.000Z", // -60,000ms skew vs baseline, -90,000ms vs parent!
          endTime: "2026-11-01T11:59:34.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-5",
          agentName: "infra-reviewer",
          eventId: "ev-5",
          replyTo: "ev-4",
          startTime: "2026-11-01T12:00:55.000Z", // +85,000ms forward vs parent
          endTime: "2026-11-01T12:00:56.000Z",
        }),
      ];

      const agg = new ThreadAggregator("extreme-clock-drift-thread", "mobile");
      const telemetry = agg.aggregate(spans);

      // 1. Strict causal topological ordering verified
      expect(telemetry.turns).toHaveLength(5);
      const orderedAgents = telemetry.turns.map((t) => t.agentName);
      expect(orderedAgents).toEqual([
        "host-lead",
        "wsl2-coder",
        "edge-architect",
        "wsl2-tester",
        "infra-reviewer",
      ]);

      // 2. Sequential turn indices and parent links
      for (let i = 0; i < 5; i++) {
        expect(telemetry.turns[i].turnIndex).toBe(i + 1);
        if (i === 0) {
          expect(telemetry.turns[i].parentTurnIndex).toBeNull();
          expect(telemetry.turns[i].depth).toBe(0);
        } else {
          expect(telemetry.turns[i].parentTurnIndex).toBe(i);
          expect(telemetry.turns[i].depth).toBe(i);
        }
      }

      // 3. Mathematical invariant: Zero causal inversions in DAG edges
      expect(telemetry.dag?.edges).toHaveLength(4);
      for (const edge of telemetry.dag!.edges) {
        expect(edge.fromTurnIndex).toBeLessThan(edge.toTurnIndex);
      }

      // 4. Exact CLOCK_SKEW anomaly detection
      const skewAnomalies = telemetry.anomalies.filter((a) => a.type === "CLOCK_SKEW");
      expect(skewAnomalies).toHaveLength(2);

      // Skew Turn 2: 45,000ms
      const skewTurn2 = skewAnomalies.find((a) => a.turnIndex === 2);
      expect(skewTurn2).toBeDefined();
      expect(skewTurn2?.severity).toBe("WARNING");
      expect(skewTurn2?.details?.skewMs).toBe(45000);
      expect(skewTurn2?.details?.childAgent).toBe("wsl2-coder");
      expect(skewTurn2?.details?.parentAgent).toBe("host-lead");

      // Skew Turn 4: 90,000ms
      const skewTurn4 = skewAnomalies.find((a) => a.turnIndex === 4);
      expect(skewTurn4).toBeDefined();
      expect(skewTurn4?.severity).toBe("WARNING");
      expect(skewTurn4?.details?.skewMs).toBe(60000); // 12:00:30.000Z vs 11:59:30.000Z = 60,000ms
      expect(skewTurn4?.details?.childAgent).toBe("wsl2-tester");
      expect(skewTurn4?.details?.parentAgent).toBe("edge-architect");

      // 5. Query Engine Invariants under extreme clock drift
      const queryEngine = new ThreadQueryEngine();

      // Query last 3 turns
      const last3 = queryEngine.filter(telemetry, { lastN: 3 });
      expect(last3.turns).toHaveLength(3);
      expect(last3.turns.map((t) => t.agentName)).toEqual([
        "edge-architect",
        "wsl2-tester",
        "infra-reviewer",
      ]);
      expect(last3.turns[0].turnIndex).toBe(3);
      expect(last3.turns[1].turnIndex).toBe(4);
      expect(last3.turns[2].turnIndex).toBe(5);

      // Query failures only: should filter turns that possess CLOCK_SKEW anomalies (Turn 2 and Turn 4)
      const failures = queryEngine.filter(telemetry, { failuresOnly: true });
      expect(failures.turns).toHaveLength(2);
      expect(failures.turns.map((t) => t.turnIndex)).toEqual([2, 4]);
    });

    it("handles total monotonic clock inversion of 60s per hop (A=240s -> B=180s -> C=120s -> D=60s -> E=0s)", () => {
      // 5 chained agents where wall clocks are strictly reversed by 60,000ms each hop
      const base = 1700000000000;
      const spans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "rev-A",
          agentName: "Agent-A",
          eventId: "ev-rev-A",
          startTime: new Date(base + 240000).toISOString(),
          endTime: new Date(base + 242000).toISOString(),
        }),
        ...createTurnSpan({
          traceId: "rev-B",
          agentName: "Agent-B",
          eventId: "ev-rev-B",
          replyTo: "ev-rev-A",
          startTime: new Date(base + 180000).toISOString(),
          endTime: new Date(base + 182000).toISOString(),
        }),
        ...createTurnSpan({
          traceId: "rev-C",
          agentName: "Agent-C",
          eventId: "ev-rev-C",
          replyTo: "ev-rev-B",
          startTime: new Date(base + 120000).toISOString(),
          endTime: new Date(base + 122000).toISOString(),
        }),
        ...createTurnSpan({
          traceId: "rev-D",
          agentName: "Agent-D",
          eventId: "ev-rev-D",
          replyTo: "ev-rev-C",
          startTime: new Date(base + 60000).toISOString(),
          endTime: new Date(base + 62000).toISOString(),
        }),
        ...createTurnSpan({
          traceId: "rev-E",
          agentName: "Agent-E",
          eventId: "ev-rev-E",
          replyTo: "ev-rev-D",
          startTime: new Date(base).toISOString(),
          endTime: new Date(base + 2000).toISOString(),
        }),
      ];

      const agg = new ThreadAggregator("total-clock-inversion", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(5);
      expect(telemetry.turns.map((t) => t.agentName)).toEqual([
        "Agent-A",
        "Agent-B",
        "Agent-C",
        "Agent-D",
        "Agent-E",
      ]);

      const skews = telemetry.anomalies.filter((a) => a.type === "CLOCK_SKEW");
      expect(skews).toHaveLength(4);
      for (const s of skews) {
        expect(s.details?.skewMs).toBe(60000);
      }
    });
  });

  /* -------------------------------------------------------------------------
   * Scenario B: Monotonic Jump & Negative Span Duration
   * ------------------------------------------------------------------------- */
  describe("Scenario B: Monotonic Jump & Negative Span Duration (startTime > endTime)", () => {
    it("flags INVALID_DURATION when agent turn span has startTime > endTime due to clock adjustment", () => {
      // Root span starts at 12:00:15.000Z and ends at 12:00:05.000Z (-10,000ms duration)
      const spans = createTurnSpan({
        traceId: "tr-negative-root",
        agentName: "clock-jump-agent",
        eventId: "ev-neg-1",
        startTime: "2026-11-01T12:00:15.000Z",
        endTime: "2026-11-01T12:00:05.000Z",
      });

      const agg = new ThreadAggregator("negative-turn-duration", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(1);
      const turn = telemetry.turns[0];

      // 1. Duration safety invariant: SpanNode durationMs must clamp to 0 and not produce negative duration
      expect(turn.durationMs).toBe(0);
      expect(telemetry.totalDurationMs).toBe(0);

      // 2. INVALID_DURATION anomaly must be detected
      const invalidAnomalies = telemetry.anomalies.filter((a) => a.type === "INVALID_DURATION");
      expect(invalidAnomalies).toHaveLength(1);

      const anomaly = invalidAnomalies[0];
      expect(anomaly.severity).toBe("WARNING");
      expect(anomaly.turnIndex).toBe(1);
      expect(anomaly.traceId).toBe("tr-negative-root");
      expect(anomaly.message).toContain("Invalid span duration detected");
      expect(anomaly.details?.negativeDurationMs).toBe(-10000);
      expect(anomaly.details?.spanName).toBe("agent_turn");
      expect(anomaly.details?.startTime).toBe("2026-11-01T12:00:15.000Z");
      expect(anomaly.details?.endTime).toBe("2026-11-01T12:00:05.000Z");

      // 3. AnomalyDetector pass-through
      const detector = new AnomalyDetector();
      const detected = detector.analyze(telemetry);
      expect(detected.filter((a) => a.type === "INVALID_DURATION")).toHaveLength(1);
    });

    it("flags INVALID_DURATION on tool execution span with negative duration without corrupting turn stats", () => {
      // Root span is valid (12:00:00 to 12:00:20)
      // Tool span has start=12:00:15.000Z, end=12:00:05.000Z (-10,000ms)
      const spans = createTurnSpan({
        traceId: "tr-tool-jump",
        agentName: "tool-runner",
        eventId: "ev-tool-jump",
        startTime: "2026-11-01T12:00:00.000Z",
        endTime: "2026-11-01T12:00:20.000Z",
        tools: [
          {
            name: "bash",
            startTime: "2026-11-01T12:00:15.000Z",
            endTime: "2026-11-01T12:00:05.000Z",
          },
        ],
      });

      const agg = new ThreadAggregator("negative-tool-duration", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(1);
      const turn = telemetry.turns[0];
      expect(turn.durationMs).toBe(20000);
      expect(turn.tools).toHaveLength(1);
      expect(turn.tools[0].durationMs).toBe(0); // Safely clamped to 0

      // Tool anomaly detected
      const invalidAnomalies = telemetry.anomalies.filter((a) => a.type === "INVALID_DURATION");
      expect(invalidAnomalies).toHaveLength(1);
      expect(invalidAnomalies[0].turnIndex).toBe(1);
      expect(invalidAnomalies[0].details?.spanName).toBe("tool:bash");
      expect(invalidAnomalies[0].details?.negativeDurationMs).toBe(-10000);
    });

    it("correctly handles combined CLOCK_SKEW and INVALID_DURATION in the same conversation", () => {
      const parent = createTurnSpan({
        traceId: "tr-p",
        agentName: "Parent",
        eventId: "ev-p",
        startTime: "2026-11-01T12:00:00.000Z",
        endTime: "2026-11-01T12:00:10.000Z",
      });

      // Child has CLOCK_SKEW (starts 30s earlier than parent) AND INVALID_DURATION (starts 11:59:30, ends 11:59:20)
      const child = createTurnSpan({
        traceId: "tr-c",
        agentName: "Child",
        eventId: "ev-c",
        replyTo: "ev-p",
        startTime: "2026-11-01T11:59:30.000Z",
        endTime: "2026-11-01T11:59:20.000Z",
      });

      const agg = new ThreadAggregator("skew-and-invalid", "mobile");
      const telemetry = agg.aggregate([...parent, ...child]);

      expect(telemetry.turns).toHaveLength(2);
      expect(telemetry.turns[0].agentName).toBe("Parent");
      expect(telemetry.turns[1].agentName).toBe("Child");

      // Anomaly checks
      const skew = telemetry.anomalies.find((a) => a.type === "CLOCK_SKEW");
      const invalid = telemetry.anomalies.find((a) => a.type === "INVALID_DURATION");

      expect(skew).toBeDefined();
      expect(skew?.turnIndex).toBe(2);
      expect(skew?.details?.skewMs).toBe(30000);

      expect(invalid).toBeDefined();
      expect(invalid?.turnIndex).toBe(2);
      expect(invalid?.details?.negativeDurationMs).toBe(-10000);

      // ThreadQueryEngine failure filter matches Turn 2
      const queryEngine = new ThreadQueryEngine();
      const filtered = queryEngine.filter(telemetry, { failuresOnly: true });
      expect(filtered.turns).toHaveLength(1);
      expect(filtered.turns[0].turnIndex).toBe(2);
      expect(filtered.anomalies).toHaveLength(2);
    });
  });

  /* -------------------------------------------------------------------------
   * Scenario C: Orphaned Turn Flood (Broken Relay History)
   * ------------------------------------------------------------------------- */
  describe("Scenario C: Orphaned Turn Flood (Broken Relay History)", () => {
    it("safely aggregates a flood of 10 orphaned turns where no reply_to IDs exist in telemetry", () => {
      // 10 agent turns where each turn points to an unresolvable Nostr event ID
      const spans: SpanNode[] = [];
      const baseTime = 1700000000000;

      for (let i = 1; i <= 10; i++) {
        spans.push(
          ...createTurnSpan({
            traceId: `tr-orphan-${i}`,
            agentName: `orphan-agent-${i}`,
            eventId: `ev-real-${i}`,
            replyTo: `ev-ghost-${i}`, // Phantom event never seen by OTel
            startTime: new Date(baseTime + i * 1000).toISOString(),
            endTime: new Date(baseTime + i * 1000 + 500).toISOString(),
          }),
        );
      }

      const agg = new ThreadAggregator("orphan-flood", "mobile");
      const telemetry = agg.aggregate(spans);

      // 1. All 10 turns preserved
      expect(telemetry.turns).toHaveLength(10);

      // 2. All 10 turns promoted to roots (forest of 10 independent roots)
      expect(telemetry.dag?.rootIndices).toHaveLength(10);
      expect(telemetry.dag?.rootIndices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // 3. No spurious DAG edges created
      expect(telemetry.dag?.edges).toHaveLength(0);

      // 4. Each turn has parentTurnIndex = null and depth = 0
      for (const turn of telemetry.turns) {
        expect(turn.parentTurnIndex).toBeNull();
        expect(turn.depth).toBe(0);
        expect(turn.childrenTurnIndices).toEqual([]);
      }

      // 5. Root turns share 'main' branch or form cohesive forest
      expect(telemetry.dag?.branches).toBeDefined();
      expect(telemetry.dag?.branches[0].branchId).toBe("main");
      expect(telemetry.dag?.branches[0].turnIndices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("correctly isolates 5 orphaned turns while faithfully reconstructing a valid sub-tree", () => {
      // Valid thread: Root -> Child1 -> Child2
      const validSpans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "tr-vr",
          agentName: "Valid-Root",
          eventId: "ev-vr",
          startTime: "2026-11-01T10:00:00.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-vc1",
          agentName: "Valid-Child1",
          eventId: "ev-vc1",
          replyTo: "ev-vr",
          startTime: "2026-11-01T10:00:01.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-vc2",
          agentName: "Valid-Child2",
          eventId: "ev-vc2",
          replyTo: "ev-vc1",
          startTime: "2026-11-01T10:00:02.000Z",
        }),
      ];

      // 5 phantom orphans
      const orphanSpans: SpanNode[] = [];
      for (let i = 1; i <= 5; i++) {
        orphanSpans.push(
          ...createTurnSpan({
            traceId: `tr-ph-${i}`,
            agentName: `Phantom-${i}`,
            eventId: `ev-ph-${i}`,
            replyTo: `ev-missing-${i}`,
            startTime: `2026-11-01T10:00:0${i + 2}.000Z`,
          }),
        );
      }

      const agg = new ThreadAggregator("mixed-orphans", "mobile");
      const telemetry = agg.aggregate([...validSpans, ...orphanSpans]);

      expect(telemetry.turns).toHaveLength(8);

      // Valid sub-tree integrity
      const root = telemetry.turns.find((t) => t.agentName === "Valid-Root")!;
      const child1 = telemetry.turns.find((t) => t.agentName === "Valid-Child1")!;
      const child2 = telemetry.turns.find((t) => t.agentName === "Valid-Child2")!;

      expect(root.parentTurnIndex).toBeNull();
      expect(child1.parentTurnIndex).toBe(root.turnIndex);
      expect(child2.parentTurnIndex).toBe(child1.turnIndex);
      expect(child2.depth).toBe(2);

      // 6 roots: Valid-Root + 5 Phantoms
      expect(telemetry.dag?.rootIndices).toHaveLength(6);
      expect(telemetry.dag?.edges).toHaveLength(2); // Valid-Root -> Child1 and Child1 -> Child2
    });
  });

  /* -------------------------------------------------------------------------
   * Scenario D: Interleaved Multi-Parent Cycles
   * ------------------------------------------------------------------------- */
  describe("Scenario D: Interleaved Multi-Parent Cycles", () => {
    it("survives directed cycle A -> B -> C -> A without infinite loop, recursion error, or hang", () => {
      // Agent A -> replies to C
      // Agent B -> replies to A
      // Agent C -> replies to B
      const spans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "tr-cyc-A",
          agentName: "Cycle-Agent-A",
          eventId: "ev-cyc-A",
          replyTo: "ev-cyc-C",
          startTime: "2026-11-01T10:00:01.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-cyc-B",
          agentName: "Cycle-Agent-B",
          eventId: "ev-cyc-B",
          replyTo: "ev-cyc-A",
          startTime: "2026-11-01T10:00:02.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-cyc-C",
          agentName: "Cycle-Agent-C",
          eventId: "ev-cyc-C",
          replyTo: "ev-cyc-B",
          startTime: "2026-11-01T10:00:03.000Z",
        }),
      ];

      const start = performance.now();
      const agg = new ThreadAggregator("pure-cycle", "mobile");
      const telemetry = agg.aggregate(spans);
      const elapsed = performance.now() - start;

      // 1. Must execute in sub-millisecond time without hanging
      expect(elapsed).toBeLessThan(50);

      // 2. All 3 turns preserved by fallback
      expect(telemetry.turns).toHaveLength(3);

      // 3. Sequential 1-based turn indices assigned
      expect(telemetry.turns.map((t) => t.turnIndex)).toEqual([1, 2, 3]);

      // 4. Branch assignment is cycle-safe and assigns branchId to all nodes
      for (const turn of telemetry.turns) {
        expect(turn.branchId).toBeDefined();
        expect(turn.branchId).toBe("main");
      }
      expect(telemetry.dag?.branches).toHaveLength(1);
    });

    it("resolves interleaved cycle with entry root and off-cycle branch safely", () => {
      // Topology:
      // Valid Root (ev-root)
      //  └── Normal Child (ev-n1)
      // Cycle: Cyc-1 (replies to Cyc-3) <-> Cyc-2 (replies to Cyc-1) <-> Cyc-3 (replies to Cyc-2)
      // Off-cycle Branch: Branch-1 (replies to Cyc-2)

      const spans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "tr-root",
          agentName: "Root",
          eventId: "ev-root",
          startTime: "2026-11-01T09:00:00.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-n1",
          agentName: "Normal-Child",
          eventId: "ev-n1",
          replyTo: "ev-root",
          startTime: "2026-11-01T09:00:01.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-c1",
          agentName: "Cyc-1",
          eventId: "ev-c1",
          replyTo: "ev-c3",
          startTime: "2026-11-01T09:00:02.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-c2",
          agentName: "Cyc-2",
          eventId: "ev-c2",
          replyTo: "ev-c1",
          startTime: "2026-11-01T09:00:03.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-c3",
          agentName: "Cyc-3",
          eventId: "ev-c3",
          replyTo: "ev-c2",
          startTime: "2026-11-01T09:00:04.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-b1",
          agentName: "Branch-1",
          eventId: "ev-b1",
          replyTo: "ev-c2", // Replies to Cyc-2 in the cycle!
          startTime: "2026-11-01T09:00:05.000Z",
        }),
      ];

      const agg = new ThreadAggregator("interleaved-cycle-branch", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(6);

      // Root and Normal-Child are processed first by Kahn's algorithm
      expect(telemetry.turns[0].agentName).toBe("Root");
      expect(telemetry.turns[0].turnIndex).toBe(1);
      expect(telemetry.turns[1].agentName).toBe("Normal-Child");
      expect(telemetry.turns[1].turnIndex).toBe(2);
      expect(telemetry.turns[1].parentTurnIndex).toBe(1);

      // Off-cycle branch has parent Cyc-2
      const cyc2 = telemetry.turns.find((t) => t.agentName === "Cyc-2")!;
      const branch1 = telemetry.turns.find((t) => t.agentName === "Branch-1")!;
      expect(branch1.parentTurnIndex).toBe(cyc2.turnIndex);

      // Every turn has a valid branchId
      for (const turn of telemetry.turns) {
        expect(turn.branchId).toBeDefined();
        expect(typeof turn.branchId).toBe("string");
      }
    });

    it("survives self-loop where agent replies to its own event ID", () => {
      const spans = createTurnSpan({
        traceId: "tr-self",
        agentName: "Self-Loop-Agent",
        eventId: "ev-self",
        replyTo: "ev-self",
        startTime: "2026-11-01T10:00:00.000Z",
      });

      const agg = new ThreadAggregator("self-loop-chaos", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(1);
      // Self-loop is discarded, promoting agent to root with depth 0
      expect(telemetry.turns[0].parentTurnIndex).toBeNull();
      expect(telemetry.turns[0].depth).toBe(0);
      expect(telemetry.dag?.rootIndices).toEqual([1]);
    });
  });

  /* -------------------------------------------------------------------------
   * Section 5: Query Engine Stress Verification under Chaos
   * ------------------------------------------------------------------------- */
  describe("Query Engine & Anomaly Detector Invariant Verification under Chaos", () => {
    it("filters and slices chaotic telemetry across all anomaly types (CLOCK_SKEW, CAUSAL_OVERLAP, INVALID_DURATION)", () => {
      // Compose complex scenario containing all anomaly types
      const spans: SpanNode[] = [
        // Turn 1: Normal root
        ...createTurnSpan({
          traceId: "t-1",
          agentName: "lead",
          eventId: "ev-1",
          startTime: "2026-11-01T10:00:00.000Z",
          endTime: "2026-11-01T10:00:05.000Z",
        }),
        // Turn 2: Causal Overlap (starts at 10:00:02, before Turn 1 finishes at 10:00:05)
        ...createTurnSpan({
          traceId: "t-2",
          agentName: "overlap-coder",
          eventId: "ev-2",
          replyTo: "ev-1",
          startTime: "2026-11-01T10:00:02.000Z",
          endTime: "2026-11-01T10:00:08.000Z",
        }),
        // Turn 3: Hard Clock Skew (starts at 09:59:00, 62s before parent starts)
        ...createTurnSpan({
          traceId: "t-3",
          agentName: "skew-tester",
          eventId: "ev-3",
          replyTo: "ev-2",
          startTime: "2026-11-01T09:59:00.000Z",
          endTime: "2026-11-01T09:59:10.000Z",
        }),
        // Turn 4: Invalid Duration (start 10:00:20, end 10:00:10)
        ...createTurnSpan({
          traceId: "t-4",
          agentName: "negative-reviewer",
          eventId: "ev-4",
          replyTo: "ev-3",
          startTime: "2026-11-01T10:00:20.000Z",
          endTime: "2026-11-01T10:00:10.000Z",
        }),
        // Turn 5: Tool Error failure
        ...createTurnSpan({
          traceId: "t-5",
          agentName: "tool-fail-agent",
          eventId: "ev-5",
          replyTo: "ev-4",
          startTime: "2026-11-01T10:00:30.000Z",
          endTime: "2026-11-01T10:00:35.000Z",
          tools: [
            {
              name: "deploy",
              statusCode: "ERROR",
            },
          ],
        }),
      ];

      const agg = new ThreadAggregator("chaos-query-suite", "mobile");
      const telemetry = agg.aggregate(spans);

      // Run AnomalyDetector
      const detector = new AnomalyDetector();
      detector.analyze(telemetry);

      expect(telemetry.turns).toHaveLength(5);

      // 1. Verify all 3 anomaly types are detected
      const overlapAnomalies = telemetry.anomalies.filter((a) => a.type === "CAUSAL_OVERLAP");
      const skewAnomalies = telemetry.anomalies.filter((a) => a.type === "CLOCK_SKEW");
      const invalidAnomalies = telemetry.anomalies.filter((a) => a.type === "INVALID_DURATION");
      const toolErrorAnomalies = telemetry.anomalies.filter((a) => a.type === "TOOL_ERROR");

      expect(overlapAnomalies.length).toBeGreaterThanOrEqual(1);
      expect(skewAnomalies.length).toBeGreaterThanOrEqual(1);
      expect(invalidAnomalies.length).toBeGreaterThanOrEqual(1);
      expect(toolErrorAnomalies.length).toBeGreaterThanOrEqual(1);

      // 2. Query Engine --failures
      const queryEngine = new ThreadQueryEngine();
      const failureTelemetry = queryEngine.filter(telemetry, { failuresOnly: true });

      // Turns 2, 3, 4, 5 each have an anomaly or error, Turn 1 is clean
      expect(failureTelemetry.turns.map((t) => t.turnIndex)).toEqual([2, 3, 4, 5]);

      // 3. Query Engine --agent
      const coderOnly = queryEngine.filter(telemetry, { agentFilter: "coder" });
      expect(coderOnly.turns).toHaveLength(1);
      expect(coderOnly.turns[0].agentName).toBe("overlap-coder");
      expect(coderOnly.anomalies).toHaveLength(1);
      expect(coderOnly.anomalies[0].type).toBe("CAUSAL_OVERLAP");

      // 4. Query Engine --turn 4
      const turn4 = queryEngine.filter(telemetry, { targetTurn: 4 });
      expect(turn4.turns).toHaveLength(1);
      expect(turn4.turns[0].turnIndex).toBe(4);
      expect(turn4.anomalies.some((a) => a.type === "INVALID_DURATION")).toBe(true);
    });
  });
});
