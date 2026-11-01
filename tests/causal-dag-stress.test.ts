import { describe, it, expect } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { ThreadQueryEngine } from "../src/engine/query.js";
import { SpanNode } from "../src/models.js";

describe("Mathematical DAG & Causal Graph Stress Tests", () => {
  // Helper to create agent turn span
  function createTurnSpan(opts: {
    traceId: string;
    agentName: string;
    eventId: string;
    replyTo?: string | null;
    startTime: string;
    endTime?: string;
    statusCode?: string;
    statusMessage?: string;
  }): SpanNode {
    return new SpanNode({
      span_id: `span-${opts.traceId}`,
      trace_id: opts.traceId,
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: opts.startTime,
      end_time: opts.endTime || opts.startTime,
      status_code: opts.statusCode || "OK",
      status_message: opts.statusMessage || null,
      attributes: {
        "session.id": "stress-test-session",
        "agent.name": opts.agentName,
        "nostr.event_id": opts.eventId,
        ...(opts.replyTo ? { "nostr.reply_to": opts.replyTo } : {}),
      },
    });
  }

  describe("1. Mathematical Invariant: Causal Ordering vs Severe Clock Skew", () => {
    it("preserves strict topological order for a 5-hop causal chain under complete chronological reversal", () => {
      // Chain: A -> B -> C -> D -> E
      // Wall clocks: E (T=100) < D (T=200) < C (T=300) < B (T=400) < A (T=500)
      const spans = [
        createTurnSpan({ traceId: "t-A", agentName: "Agent-A", eventId: "ev-A", startTime: "2026-11-01T12:00:05.000Z" }),
        createTurnSpan({ traceId: "t-B", agentName: "Agent-B", eventId: "ev-B", replyTo: "ev-A", startTime: "2026-11-01T12:00:04.000Z" }),
        createTurnSpan({ traceId: "t-C", agentName: "Agent-C", eventId: "ev-C", replyTo: "ev-B", startTime: "2026-11-01T12:00:03.000Z" }),
        createTurnSpan({ traceId: "t-D", agentName: "Agent-D", eventId: "ev-D", replyTo: "ev-C", startTime: "2026-11-01T12:00:02.000Z" }),
        createTurnSpan({ traceId: "t-E", agentName: "Agent-E", eventId: "ev-E", replyTo: "ev-D", startTime: "2026-11-01T12:00:01.000Z" }),
      ];

      const agg = new ThreadAggregator("skew-chain", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(5);

      // Verify strict topological ordering
      const orderedAgents = telemetry.turns.map((t) => t.agentName);
      expect(orderedAgents).toEqual(["Agent-A", "Agent-B", "Agent-C", "Agent-D", "Agent-E"]);

      // Verify turn indices and parent links
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

      // Verify that 4 clock skew anomalies were generated
      const skews = telemetry.anomalies.filter((a) => a.type === "CLOCK_SKEW");
      expect(skews).toHaveLength(4);
      for (const skew of skews) {
        expect(skew.severity).toBe("WARNING");
        expect(skew.message).toContain("Clock skew detected");
        expect(skew.details?.skewMs).toBe(1000);
      }
    });
  });

  describe("2. Multi-Agent Swarm Arborescence & Branching", () => {
    it("constructs an arborescence for a 10-agent swarm with 3 parallel tracks", () => {
      // Topology:
      // R (Turn 1)
      //  ├── Track 1: T1_1 (Turn 2) -> T1_2 (Turn 3) -> T1_3 (Turn 4)
      //  ├── Track 2: T2_1 (Turn 5) -> T2_2 (Turn 6)
      //  └── Track 3: T3_1 (Turn 7) -> T3_2 (Turn 8) -> T3_3 (Turn 9) -> T3_4 (Turn 10)
      const spans = [
        createTurnSpan({ traceId: "t-R", agentName: "Lead", eventId: "ev-R", startTime: "2026-11-01T10:00:00.000Z" }),
        // Track 1
        createTurnSpan({ traceId: "t-11", agentName: "T1-1", eventId: "ev-11", replyTo: "ev-R", startTime: "2026-11-01T10:00:01.000Z" }),
        createTurnSpan({ traceId: "t-12", agentName: "T1-2", eventId: "ev-12", replyTo: "ev-11", startTime: "2026-11-01T10:00:02.000Z" }),
        createTurnSpan({ traceId: "t-13", agentName: "T1-3", eventId: "ev-13", replyTo: "ev-12", startTime: "2026-11-01T10:00:03.000Z" }),
        // Track 2
        createTurnSpan({ traceId: "t-21", agentName: "T2-1", eventId: "ev-21", replyTo: "ev-R", startTime: "2026-11-01T10:00:01.500Z" }),
        createTurnSpan({ traceId: "t-22", agentName: "T2-2", eventId: "ev-22", replyTo: "ev-21", startTime: "2026-11-01T10:00:02.500Z" }),
        // Track 3
        createTurnSpan({ traceId: "t-31", agentName: "T3-1", eventId: "ev-31", replyTo: "ev-R", startTime: "2026-11-01T10:00:01.800Z" }),
        createTurnSpan({ traceId: "t-32", agentName: "T3-2", eventId: "ev-32", replyTo: "ev-31", startTime: "2026-11-01T10:00:02.800Z" }),
        createTurnSpan({ traceId: "t-33", agentName: "T3-3", eventId: "ev-33", replyTo: "ev-32", startTime: "2026-11-01T10:00:03.800Z" }),
        createTurnSpan({ traceId: "t-34", agentName: "T3-4", eventId: "ev-34", replyTo: "ev-33", startTime: "2026-11-01T10:00:04.800Z" }),
      ];

      const agg = new ThreadAggregator("swarm-tree", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(10);
      expect(telemetry.dag?.rootIndices).toEqual([1]);
      expect(telemetry.dag?.edges).toHaveLength(9); // In a tree: |E| = |V| - 1 = 10 - 1 = 9

      // Verify tree depths
      const rootTurn = telemetry.turns[0];
      expect(rootTurn.depth).toBe(0);
      expect(rootTurn.childrenTurnIndices).toHaveLength(3);

      // Verify branch partitioning: exactly 3 branches should exist
      expect(telemetry.dag?.branches).toHaveLength(3);
      const branchIds = telemetry.dag?.branches.map((b) => b.branchId);
      expect(branchIds).toContain("main");
      expect(branchIds).toContain("branch-turn1-2");
      expect(branchIds).toContain("branch-turn1-3");
    });
  });

  describe("3. Edge Case: Disconnected Components & Orphaned Turns", () => {
    it("handles multiple disconnected components where parent events are missing from telemetry", () => {
      // Graph with 3 disjoint components:
      // Component 1: ev-R1 -> ev-C1 (valid root and child)
      // Component 2: ev-O1 (replies to ev-missing-X) -> ev-O2 (replies to ev-O1)
      // Component 3: ev-Ghost (replies to ev-missing-Y, no children)
      const spans = [
        createTurnSpan({ traceId: "t-R1", agentName: "Root-1", eventId: "ev-R1", startTime: "2026-11-01T10:00:00.000Z" }),
        createTurnSpan({ traceId: "t-C1", agentName: "Child-1", eventId: "ev-C1", replyTo: "ev-R1", startTime: "2026-11-01T10:00:01.000Z" }),
        createTurnSpan({ traceId: "t-O1", agentName: "Orphan-1", eventId: "ev-O1", replyTo: "ev-missing-X", startTime: "2026-11-01T10:00:02.000Z" }),
        createTurnSpan({ traceId: "t-O2", agentName: "Orphan-2", eventId: "ev-O2", replyTo: "ev-O1", startTime: "2026-11-01T10:00:03.000Z" }),
        createTurnSpan({ traceId: "t-G1", agentName: "Ghost", eventId: "ev-G1", replyTo: "ev-missing-Y", startTime: "2026-11-01T10:00:04.000Z" }),
      ];

      const agg = new ThreadAggregator("disconnected-forest", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(5);

      // 3 components => 3 root indices: Root-1 (1), Orphan-1 (3), Ghost (5)
      expect(telemetry.dag?.rootIndices).toHaveLength(3);
      expect(telemetry.dag?.rootIndices).toContain(1);
      expect(telemetry.dag?.rootIndices).toContain(3);
      expect(telemetry.dag?.rootIndices).toContain(5);

      // Verify Orphan-1 is elevated to root with depth 0
      const orphan1 = telemetry.turns.find((t) => t.agentName === "Orphan-1")!;
      expect(orphan1.parentTurnIndex).toBeNull();
      expect(orphan1.depth).toBe(0);

      // Verify Orphan-2 correctly links to Orphan-1 as parent with depth 1
      const orphan2 = telemetry.turns.find((t) => t.agentName === "Orphan-2")!;
      expect(orphan2.parentTurnIndex).toBe(orphan1.turnIndex);
      expect(orphan2.depth).toBe(1);

      // Verify total edges = 2 (Root-1 -> Child-1 and Orphan-1 -> Orphan-2)
      expect(telemetry.dag?.edges).toHaveLength(2);
    });
  });

  describe("4. Edge Case: Multi-Root DAGs (Independent Conversation Threads)", () => {
    it("handles multiple independent root turns interleaved in physical time", () => {
      // Root A at T=1000 -> Child A at T=3000
      // Root B at T=2000 -> Child B at T=4000
      const spans = [
        createTurnSpan({ traceId: "t-RA", agentName: "Root-A", eventId: "ev-RA", startTime: "2026-11-01T10:00:01.000Z" }),
        createTurnSpan({ traceId: "t-RB", agentName: "Root-B", eventId: "ev-RB", startTime: "2026-11-01T10:00:02.000Z" }),
        createTurnSpan({ traceId: "t-CA", agentName: "Child-A", eventId: "ev-CA", replyTo: "ev-RA", startTime: "2026-11-01T10:00:03.000Z" }),
        createTurnSpan({ traceId: "t-CB", agentName: "Child-B", eventId: "ev-CB", replyTo: "ev-RB", startTime: "2026-11-01T10:00:04.000Z" }),
      ];

      const agg = new ThreadAggregator("multi-root-thread", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(4);
      expect(telemetry.dag?.rootIndices).toEqual([1, 2]);

      // Turn 1 is Root-A (T=1), Turn 2 is Root-B (T=2)
      expect(telemetry.turns[0].agentName).toBe("Root-A");
      expect(telemetry.turns[1].agentName).toBe("Root-B");

      // Child-A parent is 1, Child-B parent is 2
      const childA = telemetry.turns.find((t) => t.agentName === "Child-A")!;
      const childB = telemetry.turns.find((t) => t.agentName === "Child-B")!;
      expect(childA.parentTurnIndex).toBe(1);
      expect(childB.parentTurnIndex).toBe(2);
    });
  });

  describe("5. Edge Case: Concurrent Sibling Turns with Identical Milliseconds", () => {
    it("deterministically sequences and partitions branches for 5 agents replying at identical millisecond", () => {
      const rootSpan = createTurnSpan({
        traceId: "t-root",
        agentName: "Broadcaster",
        eventId: "ev-broadcast",
        startTime: "2026-11-01T10:00:00.000Z",
      });

      // 5 siblings all responding at exactly 10:00:01.000Z
      const siblingSpans = ["Agent-1", "Agent-2", "Agent-3", "Agent-4", "Agent-5"].map((name, idx) =>
        createTurnSpan({
          traceId: `t-sib-${idx + 1}`,
          agentName: name,
          eventId: `ev-sib-${idx + 1}`,
          replyTo: "ev-broadcast",
          startTime: "2026-11-01T10:00:01.000Z",
        }),
      );

      const agg = new ThreadAggregator("concurrent-siblings", "mobile");
      const telemetry = agg.aggregate([rootSpan, ...siblingSpans]);

      expect(telemetry.turns).toHaveLength(6);
      expect(telemetry.turns[0].agentName).toBe("Broadcaster");
      expect(telemetry.turns[0].childrenTurnIndices).toEqual([2, 3, 4, 5, 6]);

      // All siblings must have parentTurnIndex = 1 and depth = 1
      for (let i = 1; i <= 5; i++) {
        expect(telemetry.turns[i].parentTurnIndex).toBe(1);
        expect(telemetry.turns[i].depth).toBe(1);
      }

      // Branch partitioning: First sibling gets 'main', others get branch-turn1-2..5
      expect(telemetry.turns[1].branchId).toBe("main");
      expect(telemetry.turns[2].branchId).toBe("branch-turn1-2");
      expect(telemetry.turns[3].branchId).toBe("branch-turn1-3");
      expect(telemetry.turns[4].branchId).toBe("branch-turn1-4");
      expect(telemetry.turns[5].branchId).toBe("branch-turn1-5");

      expect(telemetry.dag?.branches).toHaveLength(5);
    });
  });

  describe("6. Edge Case: Cyclic Dependency Attacks & Self-Loops", () => {
    it("survives 3-cycle circular reply_to without infinite loops or stack overflow", () => {
      // 3-node cycle: A -> B -> C -> A
      const spans = [
        createTurnSpan({ traceId: "t-cA", agentName: "Cycle-A", eventId: "ev-cA", replyTo: "ev-cC", startTime: "2026-11-01T10:00:01.000Z" }),
        createTurnSpan({ traceId: "t-cB", agentName: "Cycle-B", eventId: "ev-cB", replyTo: "ev-cA", startTime: "2026-11-01T10:00:02.000Z" }),
        createTurnSpan({ traceId: "t-cC", agentName: "Cycle-C", eventId: "ev-cC", replyTo: "ev-cB", startTime: "2026-11-01T10:00:03.000Z" }),
      ];

      const agg = new ThreadAggregator("cycle-attack", "mobile");
      const telemetry = agg.aggregate(spans);

      // All 3 turns should be preserved by fallback
      expect(telemetry.turns).toHaveLength(3);
      // Because every node has in-degree 1, no node can be a root
      expect(telemetry.dag?.rootIndices).toEqual([]);
    });

    it("survives self-referencing turn where agent replies to its own event ID", () => {
      // Turn replies to itself: ev-self -> ev-self
      const span = createTurnSpan({
        traceId: "t-self",
        agentName: "Self-Loop",
        eventId: "ev-self",
        replyTo: "ev-self",
        startTime: "2026-11-01T10:00:00.000Z",
      });

      const agg = new ThreadAggregator("self-loop", "mobile");
      const telemetry = agg.aggregate([span]);

      expect(telemetry.turns).toHaveLength(1);
      // Self-loop is discarded in line 263 (`if (parent !== turn)`), so it is treated as a root node
      expect(telemetry.turns[0].parentTurnIndex).toBeNull();
      expect(telemetry.turns[0].depth).toBe(0);
      expect(telemetry.dag?.rootIndices).toEqual([1]);
    });

    it("isolates cyclic component while correctly ordering a valid sub-thread", () => {
      // Valid thread: Root -> Child
      // Malformed cycle: Cyc1 <-> Cyc2
      const spans = [
        createTurnSpan({ traceId: "t-vr", agentName: "Valid-Root", eventId: "ev-vr", startTime: "2026-11-01T10:00:00.000Z" }),
        createTurnSpan({ traceId: "t-vc", agentName: "Valid-Child", eventId: "ev-vc", replyTo: "ev-vr", startTime: "2026-11-01T10:00:05.000Z" }),
        createTurnSpan({ traceId: "t-y1", agentName: "Cyc-1", eventId: "ev-y1", replyTo: "ev-y2", startTime: "2026-11-01T10:00:01.000Z" }),
        createTurnSpan({ traceId: "t-y2", agentName: "Cyc-2", eventId: "ev-y2", replyTo: "ev-y1", startTime: "2026-11-01T10:00:02.000Z" }),
      ];

      const agg = new ThreadAggregator("mixed-cycle-thread", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(4);

      // The valid root (inDegree 0) must be resolved first by Kahn's algorithm
      expect(telemetry.turns[0].agentName).toBe("Valid-Root");
      expect(telemetry.turns[1].agentName).toBe("Valid-Child");
      expect(telemetry.turns[1].parentTurnIndex).toBe(1);

      // The cycle nodes Cyc-1 and Cyc-2 must follow in fallback
      expect(telemetry.turns[2].agentName).toBe("Cyc-1");
      expect(telemetry.turns[3].agentName).toBe("Cyc-2");

      // Root indices should only identify Valid-Root
      expect(telemetry.dag?.rootIndices).toEqual([1]);
    });
  });

  describe("7. Causal Overlap Anomaly Threshold Boundaries", () => {
    it("triggers causal overlap when child starts 101ms before parent ends", () => {
      const parent = createTurnSpan({
        traceId: "t-p",
        agentName: "Parent",
        eventId: "ev-p",
        startTime: "2026-11-01T10:00:00.000Z",
        endTime: "2026-11-01T10:00:10.000Z", // ends at 10.000s
      });
      const child = createTurnSpan({
        traceId: "t-c",
        agentName: "Child",
        eventId: "ev-c",
        replyTo: "ev-p",
        startTime: "2026-11-01T10:00:09.899Z", // starts at 9.899s (101ms before parent ends)
        endTime: "2026-11-01T10:00:15.000Z",
      });

      const agg = new ThreadAggregator("overlap-101ms", "mobile");
      const telemetry = agg.aggregate([parent, child]);

      const overlap = telemetry.anomalies.find((a) => (a.type === "CAUSAL_OVERLAP" || a.type === "CLOCK_SKEW") && a.message.includes("Causal overlap"));
      expect(overlap).toBeDefined();
      expect(overlap?.details?.skewMs).toBe(101);
    });

    it("does NOT trigger causal overlap when child starts within the 100ms tolerance window (99ms before parent ends)", () => {
      const parent = createTurnSpan({
        traceId: "t-p2",
        agentName: "Parent",
        eventId: "ev-p2",
        startTime: "2026-11-01T10:00:00.000Z",
        endTime: "2026-11-01T10:00:10.000Z", // ends at 10.000s
      });
      const child = createTurnSpan({
        traceId: "t-c2",
        agentName: "Child",
        eventId: "ev-c2",
        replyTo: "ev-p2",
        startTime: "2026-11-01T10:00:09.901Z", // starts at 9.901s (99ms before parent ends: within 100ms tolerance)
        endTime: "2026-11-01T10:00:15.000Z",
      });

      const agg = new ThreadAggregator("overlap-99ms", "mobile");
      const telemetry = agg.aggregate([parent, child]);

      const overlap = telemetry.anomalies.find((a) => (a.type === "CAUSAL_OVERLAP" || a.type === "CLOCK_SKEW") && a.message.includes("Causal overlap"));
      expect(overlap).toBeUndefined();
    });

    it("distinguishes hard clock skew (child starts before parent starts) from causal overlap", () => {
      const parent = createTurnSpan({
        traceId: "t-p3",
        agentName: "Parent",
        eventId: "ev-p3",
        startTime: "2026-11-01T10:00:05.000Z",
        endTime: "2026-11-01T10:00:10.000Z",
      });
      const child = createTurnSpan({
        traceId: "t-c3",
        agentName: "Child",
        eventId: "ev-c3",
        replyTo: "ev-p3",
        startTime: "2026-11-01T10:00:04.500Z", // starts 500ms before parent even STARTED
        endTime: "2026-11-01T10:00:08.000Z",
      });

      const agg = new ThreadAggregator("hard-skew", "mobile");
      const telemetry = agg.aggregate([parent, child]);

      const anomalies = telemetry.anomalies.filter((a) => a.type === "CLOCK_SKEW");
      expect(anomalies).toHaveLength(1);
      // Hard clock skew message must be emitted, not causal overlap
      expect(anomalies[0].message).toContain("Clock skew detected");
      expect(anomalies[0].message).not.toContain("Causal overlap");
      expect(anomalies[0].details?.skewMs).toBe(500);
    });
  });

  describe("8. Query Engine Causal Invariant Verification", () => {
    it("maintains topological ordering when filtering by --last N", () => {
      const spans = [
        createTurnSpan({ traceId: "t-1", agentName: "Agent-1", eventId: "ev-1", startTime: "2026-11-01T10:00:05.000Z" }),
        createTurnSpan({ traceId: "t-2", agentName: "Agent-2", eventId: "ev-2", replyTo: "ev-1", startTime: "2026-11-01T10:00:04.000Z" }), // skew!
        createTurnSpan({ traceId: "t-3", agentName: "Agent-3", eventId: "ev-3", replyTo: "ev-2", startTime: "2026-11-01T10:00:03.000Z" }), // skew!
        createTurnSpan({ traceId: "t-4", agentName: "Agent-4", eventId: "ev-4", replyTo: "ev-3", startTime: "2026-11-01T10:00:02.000Z" }), // skew!
      ];

      const agg = new ThreadAggregator("query-skew", "mobile");
      const telemetry = agg.aggregate(spans);

      const queryEngine = new ThreadQueryEngine();
      const filtered = queryEngine.filter(telemetry, { lastN: 2 });

      // Last 2 turns topologically should be Turn 3 (Agent-3) and Turn 4 (Agent-4)
      expect(filtered.turns).toHaveLength(2);
      expect(filtered.turns[0].agentName).toBe("Agent-3");
      expect(filtered.turns[0].turnIndex).toBe(3);
      expect(filtered.turns[1].agentName).toBe("Agent-4");
      expect(filtered.turns[1].turnIndex).toBe(4);
    });
  });
});
