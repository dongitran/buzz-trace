/**
 * Thread Telemetry Aggregator.
 * Assembles raw OpenTelemetry spans across multiple agent turns into a unified ThreadTelemetry timeline.
 */

import {
  AgentTurn,
  Anomaly,
  SpanNode,
  ThreadBranch,
  ThreadDAG,
  ThreadDAGEdge,
  ThreadTelemetry,
  ToolExecution,
} from "../models.js";
import { extractSemanticToolInput } from "../formatters/compact-fmt.js";

export class ThreadAggregator {
  readonly threadId: string;
  readonly project: string;
  readonly sessionId?: string | null;
  readonly phoenixUiUrl?: string | null;

  constructor(threadId: string, project = "mobile", sessionId?: string | null, phoenixUiUrl?: string | null) {
    this.threadId = threadId;
    this.project = project;
    this.sessionId = sessionId;
    this.phoenixUiUrl = phoenixUiUrl;
  }

  aggregate(spans: SpanNode[]): ThreadTelemetry {
    if (!spans || spans.length === 0) {
      return new ThreadTelemetry({
        threadId: this.threadId,
        project: this.project,
        sessionId: this.sessionId || null,
        status: "NOT_FOUND",
      });
    }

    // 1. Group spans by traceId
    const tracesMap = new Map<string, SpanNode[]>();
    for (const span of spans) {
      if (span.traceId) {
        const list = tracesMap.get(span.traceId) || [];
        list.push(span);
        tracesMap.set(span.traceId, list);
      }
    }

    // 2. Build AgentTurn for each trace
    const rawTurns: AgentTurn[] = [];
    for (const [traceId, traceSpans] of tracesMap.entries()) {
      rawTurns.push(this.buildTurn(traceId, traceSpans));
    }

    // 2b. Detect INVALID_DURATION (monotonic clock jumps where start_time > end_time)
    const invalidDurationAnomalies: Anomaly[] = [];
    for (const span of spans) {
      if (span.startTime && span.endTime && span.startTime.getTime() > span.endTime.getTime()) {
        const negativeMs = span.startTime.getTime() - span.endTime.getTime();
        invalidDurationAnomalies.push({
          type: "INVALID_DURATION",
          severity: "WARNING",
          message: `Invalid span duration detected: span '${span.name}' has startTime (${span.startTime.toISOString()}) later than endTime (${span.endTime.toISOString()}) by ${negativeMs}ms due to monotonic clock jump.`,
          traceId: span.traceId,
          details: {
            spanId: span.spanId,
            spanName: span.name,
            negativeDurationMs: -negativeMs,
            startTime: span.startTime.toISOString(),
            endTime: span.endTime.toISOString(),
          },
        });
      }
    }

    // 3. Sort turns topologically (causality-first, clock-skew resilient) and build thread DAG
    const { turns, dag, anomalies: orderingAnomalies } = this.orderTurnsAndBuildDAG(rawTurns, invalidDurationAnomalies);

    // 4. Compute aggregate statistics
    const totalTokens = turns.reduce((acc, t) => acc + t.totalTokens, 0);
    const totalPromptTokens = turns.reduce((acc, t) => acc + t.promptTokens, 0);
    const totalCompletionTokens = turns.reduce((acc, t) => acc + t.completionTokens, 0);
    const totalDurationMs = turns.reduce((acc, t) => acc + t.durationMs, 0);

    const threadStart = turns.length > 0 ? turns[0].startTime : undefined;
    const threadEnd = turns.length > 0 ? turns[turns.length - 1].endTime : undefined;

    let overallStatus = "OK";
    if (turns.some((t) => t.statusCode === "ERROR")) {
      overallStatus = "ERROR";
    }

    let nostrThreadId: string | null = null;
    let nostrChannelId: string | null = null;

    for (const turn of turns) {
      for (const span of turn.spans) {
        if (!nostrThreadId && span.attributes["nostr.thread_id"]) {
          nostrThreadId = span.attributes["nostr.thread_id"] as string;
        }
        if (!nostrChannelId && span.attributes["nostr.channel_id"]) {
          nostrChannelId = span.attributes["nostr.channel_id"] as string;
        }
      }
    }

    const resolvedSessionId =
      this.sessionId ||
      (turns.length > 0 && turns[0].spans.length > 0
        ? (turns[0].spans[0].attributes["session.id"] as string)
        : null);

    return new ThreadTelemetry({
      threadId: this.threadId,
      project: this.project,
      sessionId: resolvedSessionId,
      nostrThreadId,
      nostrChannelId,
      totalTurns: turns.length,
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      totalDurationMs,
      startTime: threadStart,
      endTime: threadEnd,
      status: overallStatus,
      dag,
      turns,
      anomalies: orderingAnomalies,
    });
  }

  private buildTurn(traceId: string, spans: SpanNode[]): AgentTurn {
    // Find root span
    let rootSpan: SpanNode | undefined = spans.find((s) => s.name === "agent_turn" || s.parentId === null);
    if (!rootSpan && spans.length > 0) {
      rootSpan = spans[0];
    }

    const turnStart = rootSpan?.startTime;
    const turnEnd = rootSpan?.endTime;
    const turnDuration = rootSpan?.durationMs || 0;
    const turnStatus = rootSpan?.statusCode || "OK";
    const turnMsg = rootSpan?.statusMessage || null;

    // Agent name and Nostr event attribution
    let agentName = "unknown-agent";
    let nostrEventId: string | null = null;
    let nostrReplyTo: string | null = null;

    if (rootSpan) {
      const attrs = rootSpan.attributes;
      agentName =
        (attrs["agent.id"] as string) ||
        (attrs["agent.name"] as string) ||
        (attrs["service.name"] as string) ||
        (attrs["agent_name"] as string) ||
        (attrs["community.agent"] as string) ||
        "phoenix-twin";

      nostrEventId = (attrs["nostr.event_id"] as string) || null;
      nostrReplyTo = (attrs["nostr.reply_to"] as string) || null;
    }

    let modelName = "unknown-model";
    if (rootSpan) {
      const rootModel =
        (rootSpan.attributes["llm.model_name"] as string) ||
        (rootSpan.attributes["llm.model"] as string) ||
        (rootSpan.attributes["gen_ai.request.model"] as string) ||
        (rootSpan.attributes["model"] as string);
      if (rootModel) {
        modelName = rootModel;
      }
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let totalTokens = 0;

    let promptPreview = "";
    let responsePreview = "";
    const tools: ToolExecution[] = [];

    for (const span of spans) {
      const attrs = span.attributes;

      // Check for LLM span
      const detectedModel =
        (attrs["llm.model_name"] as string) ||
        (attrs["llm.model"] as string) ||
        (attrs["gen_ai.request.model"] as string) ||
        (attrs["model"] as string);

      if (
        span.name.startsWith("llm:") ||
        span.spanKind === "LLM" ||
        detectedModel !== undefined
      ) {
        if (detectedModel) {
          modelName = detectedModel;
        }
        promptTokens += Number(attrs["llm.token_count.prompt"] || 0);
        completionTokens += Number(attrs["llm.token_count.completion"] || 0);
        reasoningTokens += Number(attrs["llm.token_count.completion_details.reasoning"] || 0);
        totalTokens += Number(attrs["llm.token_count.total"] || 0);
      }

      const isToolSpan =
        span.name.startsWith("tool:") ||
        ((span.spanKind === "TOOL" || span.spanKind === "SPAN_KIND_INTERNAL") && "tool.name" in attrs);

      // Prompt and response previews (from agent turn or non-tool spans)
      if (!isToolSpan) {
        if (!promptPreview && attrs["input.value"]) {
          const rawIn = String(attrs["input.value"]).trim();
          promptPreview = rawIn.length > 120 ? `${rawIn.slice(0, 120)}...` : rawIn;
        }
        if (!responsePreview && attrs["output.value"]) {
          const rawOut = String(attrs["output.value"]).trim();
          responsePreview = rawOut.length > 120 ? `${rawOut.slice(0, 120)}...` : rawOut;
        }
      }

      // Check for Tool span
      if (isToolSpan) {
        const toolName = (attrs["tool.name"] as string) || span.name.replace(/^tool:/, "");
        const rawToolIn = attrs["input.value"];
        const semanticIn = extractSemanticToolInput(rawToolIn);
        const toolIn = semanticIn.length > 80 ? semanticIn.slice(0, 80) : semanticIn;
        const toolBytes = Number(attrs["tool.output_bytes"] || 0);

        tools.push({
          name: toolName,
          durationMs: span.durationMs,
          statusCode: span.statusCode,
          error: span.statusCode === "ERROR" ? span.statusMessage : null,
          inputSummary: toolIn,
          outputBytes: toolBytes,
          spanId: span.spanId,
        });
      }
    }

    if (totalTokens === 0 && (promptTokens > 0 || completionTokens > 0)) {
      totalTokens = promptTokens + completionTokens;
    }

    return {
      turnIndex: 0,
      traceId,
      agentName,
      modelName,
      nostrEventId,
      nostrReplyTo,
      startTime: turnStart,
      endTime: turnEnd,
      durationMs: turnDuration,
      promptTokens,
      completionTokens,
      reasoningTokens,
      totalTokens,
      statusCode: turnStatus,
      statusMessage: turnMsg,
      promptPreview,
      responsePreview,
      tools,
      spans,
    };
  }

  private orderTurnsAndBuildDAG(
    rawTurns: AgentTurn[],
    additionalAnomalies: Anomaly[] = [],
  ): {
    turns: AgentTurn[];
    dag: ThreadDAG;
    anomalies: Anomaly[];
  } {
    if (rawTurns.length === 0) {
      return {
        turns: [],
        dag: { rootIndices: [], edges: [], branches: [] },
        anomalies: additionalAnomalies,
      };
    }

    // Index turns by nostrEventId
    const eventToTurn = new Map<string, AgentTurn>();
    for (const turn of rawTurns) {
      if (turn.nostrEventId) {
        eventToTurn.set(turn.nostrEventId, turn);
      }
    }

    // Build dependency graph
    const parentMap = new Map<AgentTurn, AgentTurn>();
    const childrenMap = new Map<AgentTurn, AgentTurn[]>();
    const inDegree = new Map<AgentTurn, number>();
    const clockSkewAnomalies: Anomaly[] = [];

    for (const turn of rawTurns) {
      inDegree.set(turn, 0);
      childrenMap.set(turn, []);
    }

    for (const turn of rawTurns) {
      if (turn.nostrReplyTo && eventToTurn.has(turn.nostrReplyTo)) {
        const parent = eventToTurn.get(turn.nostrReplyTo)!;
        if (parent !== turn) {
          parentMap.set(turn, parent);
          childrenMap.get(parent)!.push(turn);
          inDegree.set(turn, (inDegree.get(turn) || 0) + 1);

          // Clock skew check: causal parent should precede child chronologically
          if (parent.startTime && turn.startTime) {
            const parentTime = parent.startTime.getTime();
            const childTime = turn.startTime.getTime();
            const parentEndTime = parent.endTime ? parent.endTime.getTime() : parentTime;

            if (childTime < parentTime) {
              const skewMs = parentTime - childTime;
              clockSkewAnomalies.push({
                type: "CLOCK_SKEW",
                severity: "WARNING",
                message: `Clock skew detected: '${turn.agentName}' replied to '${parent.agentName}', but its start timestamp is earlier by ${skewMs}ms due to container clock drift.`,
                traceId: turn.traceId,
                details: {
                  childAgent: turn.agentName,
                  parentAgent: parent.agentName,
                  skewMs,
                  childStartTime: turn.startTime.toISOString(),
                  parentStartTime: parent.startTime.toISOString(),
                },
              });
            } else if (parent.endTime && childTime < parentEndTime - 100) {
              const overlapMs = parentEndTime - childTime;
              clockSkewAnomalies.push({
                type: "CAUSAL_OVERLAP",
                severity: "WARNING",
                message: `Causal overlap detected: '${turn.agentName}' started ${overlapMs}ms before '${parent.agentName}' finished executing.`,
                traceId: turn.traceId,
                details: {
                  childAgent: turn.agentName,
                  parentAgent: parent.agentName,
                  skewMs: overlapMs,
                  childStartTime: turn.startTime.toISOString(),
                  parentEndTime: parent.endTime.toISOString(),
                },
              });
            }
          }
        }
      }
    }

    // Helper for deterministic tie-breaking (timestamp first, then event/trace ID)
    const compareTurns = (a: AgentTurn, b: AgentTurn): number => {
      const tA = a.startTime ? a.startTime.getTime() : 0;
      const tB = b.startTime ? b.startTime.getTime() : 0;
      if (tA !== tB) {
        return tA - tB;
      }
      const keyA = a.nostrEventId || a.traceId;
      const keyB = b.nostrEventId || b.traceId;
      return keyA.localeCompare(keyB);
    };

    // Topological Sort (Kahn's algorithm with timestamp and identifier tie-breaking)
    const sortedTurns: AgentTurn[] = [];
    const ready: AgentTurn[] = rawTurns.filter((t) => inDegree.get(t) === 0);
    ready.sort(compareTurns);

    while (ready.length > 0) {
      const current = ready.shift()!;
      sortedTurns.push(current);

      const children = childrenMap.get(current) || [];
      for (const child of children) {
        const deg = (inDegree.get(child) || 1) - 1;
        inDegree.set(child, deg);
        if (deg === 0) {
          const insertIdx = ready.findIndex((item) => compareTurns(item, child) > 0);
          if (insertIdx === -1) {
            ready.push(child);
          } else {
            ready.splice(insertIdx, 0, child);
          }
        }
      }
    }

    // Fallback if graph had cycles or disconnected unreached nodes
    if (sortedTurns.length < rawTurns.length) {
      const remaining = rawTurns.filter((t) => !sortedTurns.includes(t));
      remaining.sort(compareTurns);
      sortedTurns.push(...remaining);
    }

    // Assign sequential 1-based turnIndex and tree fields
    for (let i = 0; i < sortedTurns.length; i++) {
      sortedTurns[i].turnIndex = i + 1;
      sortedTurns[i].childrenTurnIndices = [];
    }

    const dagEdges: ThreadDAGEdge[] = [];
    const rootIndices: number[] = [];

    for (const turn of sortedTurns) {
      const parent = parentMap.get(turn);
      if (parent) {
        turn.parentTurnIndex = parent.turnIndex;
        turn.depth = (parent.depth ?? 0) + 1;
        parent.childrenTurnIndices = parent.childrenTurnIndices || [];
        parent.childrenTurnIndices.push(turn.turnIndex);
        dagEdges.push({
          fromTurnIndex: parent.turnIndex,
          toTurnIndex: turn.turnIndex,
          type: "REPLY_TO",
        });
      } else {
        turn.parentTurnIndex = null;
        turn.depth = 0;
        rootIndices.push(turn.turnIndex);
      }
    }

    // Assign branch IDs
    for (const rootIdx of rootIndices) {
      const rootTurn = sortedTurns.find((t) => t.turnIndex === rootIdx);
      if (rootTurn) {
        rootTurn.branchId = rootTurn.branchId || "main";
        this.assignBranches(rootTurn, sortedTurns);
      }
    }

    // Ensure all turns have a branchId (e.g. for cyclic components without roots)
    for (const turn of sortedTurns) {
      if (!turn.branchId) {
        turn.branchId = "main";
      }
    }

    const branchMap = new Map<string, number[]>();
    for (const turn of sortedTurns) {
      const bId = turn.branchId || "main";
      const list = branchMap.get(bId) || [];
      list.push(turn.turnIndex);
      branchMap.set(bId, list);
    }

    const branches: ThreadBranch[] = Array.from(branchMap.entries()).map(([branchId, turnIndices]) => ({
      branchId,
      rootTurnIndex: turnIndices[0],
      turnIndices,
    }));

    const dag: ThreadDAG = {
      rootIndices,
      edges: dagEdges,
      branches,
    };

    // Attach turnIndex to all anomalies
    const allAnomalies = [...clockSkewAnomalies, ...additionalAnomalies];
    for (const a of allAnomalies) {
      const matchingTurn = sortedTurns.find((t) => t.traceId === a.traceId);
      if (matchingTurn) {
        a.turnIndex = matchingTurn.turnIndex;
        if (a.details) {
          a.details.turnIndex = matchingTurn.turnIndex;
          if (matchingTurn.parentTurnIndex) {
            a.details.parentTurnIndex = matchingTurn.parentTurnIndex;
          }
        }
      }
    }

    return { turns: sortedTurns, dag, anomalies: allAnomalies };
  }

  private assignBranches(current: AgentTurn, allTurns: AgentTurn[], visited = new Set<number>()): void {
    if (visited.has(current.turnIndex)) {
      return;
    }
    visited.add(current.turnIndex);

    const children = (current.childrenTurnIndices || [])
      .map((idx) => allTurns.find((t) => t.turnIndex === idx))
      .filter((t): t is AgentTurn => t !== undefined);

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child.branchId) {
        if (i === 0 && current.branchId) {
          child.branchId = current.branchId;
        } else {
          child.branchId = `branch-turn${current.turnIndex}-${i + 1}`;
        }
      }
      this.assignBranches(child, allTurns, visited);
    }
  }
}
