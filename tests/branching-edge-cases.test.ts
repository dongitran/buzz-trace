import { describe, it, expect } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { SpanNode } from "../src/models.js";

describe("Subagent 2.2: Branching Edge Cases & Relayed Resolution", () => {
  function createTurnSpan(opts: {
    traceId: string;
    agentName: string;
    eventId: string;
    replyTo?: string | null;
    rootId?: string | null;
    startTime: string;
    endTime?: string;
  }): SpanNode[] {
    return [
      new SpanNode({
        span_id: `span-${opts.traceId}`,
        trace_id: opts.traceId,
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: opts.startTime,
        end_time: opts.endTime || opts.startTime,
        status_code: "OK",
        attributes: {
          "session.id": "branching-edge-case-session",
          "agent.name": opts.agentName,
          "nostr.event_id": opts.eventId,
          ...(opts.replyTo ? { "nostr.reply_to": opts.replyTo } : {}),
          ...(opts.rootId ? { "nostr.root_id": opts.rootId } : {}),
        },
      }),
    ];
  }

  describe("Edge Case 1: Multiple siblings replying to the same event", () => {
    it("correctly resolves 5 concurrent siblings replying to Turn 1 with depth 1 and branch partitioning", () => {
      // Turn 1: Root event (ev-root)
      // Turn 2..6: 5 sibling agents all directly replying to ev-root
      const spans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "tr-root",
          agentName: "lead-agent",
          eventId: "ev-root",
          startTime: "2026-11-01T10:00:00.000Z",
          endTime: "2026-11-01T10:00:05.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-sib-1",
          agentName: "coder-agent",
          eventId: "ev-sib-1",
          replyTo: "ev-root",
          startTime: "2026-11-01T10:00:06.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-sib-2",
          agentName: "architect-agent",
          eventId: "ev-sib-2",
          replyTo: "ev-root",
          startTime: "2026-11-01T10:00:07.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-sib-3",
          agentName: "reviewer-agent",
          eventId: "ev-sib-3",
          replyTo: "ev-root",
          startTime: "2026-11-01T10:00:08.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-sib-4",
          agentName: "qa-agent",
          eventId: "ev-sib-4",
          replyTo: "ev-root",
          startTime: "2026-11-01T10:00:09.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-sib-5",
          agentName: "security-agent",
          eventId: "ev-sib-5",
          replyTo: "ev-root",
          startTime: "2026-11-01T10:00:10.000Z",
        }),
      ];

      const agg = new ThreadAggregator("branch-siblings", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(6);

      // Kahn's sort places root Turn 1 first
      expect(telemetry.turns[0].agentName).toBe("lead-agent");
      expect(telemetry.turns[0].turnIndex).toBe(1);
      expect(telemetry.turns[0].depth).toBe(0);
      expect(telemetry.turns[0].parentTurnIndex).toBeNull();
      expect(telemetry.turns[0].childrenTurnIndices).toEqual([2, 3, 4, 5, 6]);

      // All 5 siblings have depth 1, parentTurnIndex 1
      for (let i = 1; i < 6; i++) {
        const turn = telemetry.turns[i];
        expect(turn.parentTurnIndex).toBe(1);
        expect(turn.depth).toBe(1);
      }

      // Branch partitioning: exactly 5 branches
      expect(telemetry.dag?.branches).toHaveLength(5);
      const branchIds = telemetry.dag?.branches.map((b) => b.branchId);
      expect(branchIds).toContain("main");
      expect(branchIds).toContain("branch-turn1-2");
      expect(branchIds).toContain("branch-turn1-3");
      expect(branchIds).toContain("branch-turn1-4");
      expect(branchIds).toContain("branch-turn1-5");
    });
  });

  describe("Edge Case 2: Reply has an invalid or missing root tag", () => {
    it("resolves parent pointer via reply_to when root tag is invalid (bogus non-existent ID)", () => {
      const spans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "tr-1",
          agentName: "lead-agent",
          eventId: "ev-lead",
          startTime: "2026-11-01T10:00:00.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-2",
          agentName: "coder-agent",
          eventId: "ev-coder",
          replyTo: "ev-lead",
          rootId: "bogus-nonexistent-root-tag-999999", // Invalid root tag
          startTime: "2026-11-01T10:00:05.000Z",
        }),
      ];

      const agg = new ThreadAggregator("test-invalid-root", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(2);
      expect(telemetry.turns[0].turnIndex).toBe(1);
      expect(telemetry.turns[0].depth).toBe(0);

      // Coder turn successfully resolves to Turn 1 despite bogus root tag
      expect(telemetry.turns[1].turnIndex).toBe(2);
      expect(telemetry.turns[1].parentTurnIndex).toBe(1);
      expect(telemetry.turns[1].depth).toBe(1);
      expect(telemetry.dag?.edges).toEqual([
        { fromTurnIndex: 1, toTurnIndex: 2, type: "REPLY_TO" },
      ]);
    });

    it("resolves parent pointer via reply_to when root tag is missing (null/undefined)", () => {
      const spans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "tr-1",
          agentName: "lead-agent",
          eventId: "ev-lead",
          startTime: "2026-11-01T10:00:00.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-2",
          agentName: "coder-agent",
          eventId: "ev-coder",
          replyTo: "ev-lead",
          rootId: null, // Missing root tag
          startTime: "2026-11-01T10:00:05.000Z",
        }),
      ];

      const agg = new ThreadAggregator("test-missing-root", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(2);
      expect(telemetry.turns[1].parentTurnIndex).toBe(1);
      expect(telemetry.turns[1].depth).toBe(1);
    });

    it("falls back to root tag when reply_to points to an unindexed assistant response event", () => {
      // Turn 1 event is ev-turn1-prompt. In Turn 1 the agent sent ev-turn1-agent-reply (not an agent_turn event ID).
      // Turn 2 reply_to is ev-turn1-agent-reply, but root_id is ev-turn1-prompt.
      const spans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "tr-1",
          agentName: "phoenix-twin",
          eventId: "ev-turn1-prompt",
          startTime: "2026-11-01T10:00:00.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-2",
          agentName: "phoenix-twin",
          eventId: "ev-turn2-prompt",
          replyTo: "ev-turn1-agent-reply", // Relayed response message, not in eventToTurn!
          rootId: "ev-turn1-prompt",       // Fallback root tag
          startTime: "2026-11-01T10:01:00.000Z",
        }),
      ];

      const agg = new ThreadAggregator("test-relayed-fallback", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(2);
      expect(telemetry.turns[0].turnIndex).toBe(1);
      expect(telemetry.turns[0].depth).toBe(0);

      // Successfully resolved via root tag fallback
      expect(telemetry.turns[1].turnIndex).toBe(2);
      expect(telemetry.turns[1].parentTurnIndex).toBe(1);
      expect(telemetry.turns[1].depth).toBe(1);
      expect(telemetry.dag?.edges).toEqual([
        { fromTurnIndex: 1, toTurnIndex: 2, type: "REPLY_TO" },
      ]);
    });

    it("handles orphaned turn with unknown reply_to and missing root tag gracefully as independent root", () => {
      const spans: SpanNode[] = [
        ...createTurnSpan({
          traceId: "tr-1",
          agentName: "agent-1",
          eventId: "ev-1",
          startTime: "2026-11-01T10:00:00.000Z",
        }),
        ...createTurnSpan({
          traceId: "tr-2",
          agentName: "agent-2",
          eventId: "ev-2",
          replyTo: "ghost-event-not-found",
          rootId: null, // Missing root tag as well
          startTime: "2026-11-01T10:00:05.000Z",
        }),
      ];

      const agg = new ThreadAggregator("test-orphaned", "mobile");
      const telemetry = agg.aggregate(spans);

      expect(telemetry.turns).toHaveLength(2);
      // Both become root nodes cleanly
      expect(telemetry.turns[0].parentTurnIndex).toBeNull();
      expect(telemetry.turns[0].depth).toBe(0);
      expect(telemetry.turns[1].parentTurnIndex).toBeNull();
      expect(telemetry.turns[1].depth).toBe(0);
      expect(telemetry.dag?.rootIndices).toEqual([1, 2]);
    });
  });
});
