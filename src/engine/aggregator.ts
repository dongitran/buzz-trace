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

    // 3. Sort turns topologically (causality-first, clock-skew resilient) and build thread DAG
    const { turns, dag, clockSkewAnomalies } = this.orderTurnsAndBuildDAG(rawTurns);

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
      anomalies: clockSkewAnomalies,
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
      if (
        span.name.startsWith("llm:") ||
        ((span.spanKind === "LLM" || span.spanKind === "SPAN_KIND_INTERNAL") && "llm.model_name" in attrs)
      ) {
        modelName = (attrs["llm.model_name"] as string) || modelName;
        promptTokens += Number(attrs["llm.token_count.prompt"] || 0);
        completionTokens += Number(attrs["llm.token_count.completion"] || 0);
        reasoningTokens += Number(attrs["llm.token_count.completion_details.reasoning"] || 0);
        totalTokens += Number(attrs["llm.token_count.total"] || 0);
      }

      // Prompt and response previews
      if (!promptPreview && attrs["input.value"]) {
        const rawIn = String(attrs["input.value"]).trim();
        promptPreview = rawIn.length > 120 ? `${rawIn.slice(0, 120)}...` : rawIn;
      }
      if (!responsePreview && attrs["output.value"]) {
        const rawOut = String(attrs["output.value"]).trim();
        responsePreview = rawOut.length > 120 ? `${rawOut.slice(0, 120)}...` : rawOut;
      }

      // Check for Tool span
      if (
        span.name.startsWith("tool:") ||
        ((span.spanKind === "TOOL" || span.spanKind === "SPAN_KIND_INTERNAL") && "tool.name" in attrs)
      ) {
        const toolName = (attrs["tool.name"] as string) || span.name.replace(/^tool:/, "");
        const toolIn = String(attrs["input.value"] || "").slice(0, 80);
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

  private orderTurnsAndBuildDAG(rawTurns: AgentTurn[]): {
    turns: AgentTurn[];
    dag: ThreadDAG;
    clockSkewAnomalies: Anomaly[];
  } {
    if (rawTurns.length === 0) {
      return {
        turns: [],
        dag: { rootIndices: [], edges: [], branches: [] },
        clockSkewAnomalies: [],
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
            }
          }
        }
      }
    }

    // Topological Sort (Kahn's algorithm with timestamp tie-breaking)
    const sortedTurns: AgentTurn[] = [];
    const ready: AgentTurn[] = rawTurns.filter((t) => inDegree.get(t) === 0);
    ready.sort((a, b) => {
      const tA = a.startTime ? a.startTime.getTime() : 0;
      const tB = b.startTime ? b.startTime.getTime() : 0;
      return tA - tB;
    });

    while (ready.length > 0) {
      const current = ready.shift()!;
      sortedTurns.push(current);

      const children = childrenMap.get(current) || [];
      for (const child of children) {
        const deg = (inDegree.get(child) || 1) - 1;
        inDegree.set(child, deg);
        if (deg === 0) {
          const childTime = child.startTime ? child.startTime.getTime() : 0;
          const insertIdx = ready.findIndex((item) => {
            const itemTime = item.startTime ? item.startTime.getTime() : 0;
            return itemTime > childTime;
          });
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
      remaining.sort((a, b) => {
        const tA = a.startTime ? a.startTime.getTime() : 0;
        const tB = b.startTime ? b.startTime.getTime() : 0;
        return tA - tB;
      });
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

    // Attach turnIndex to clockSkewAnomalies
    for (const a of clockSkewAnomalies) {
      const matchingTurn = sortedTurns.find((t) => t.traceId === a.traceId);
      if (matchingTurn) {
        a.turnIndex = matchingTurn.turnIndex;
        if (a.details && matchingTurn.parentTurnIndex) {
          a.details.turnIndex = matchingTurn.turnIndex;
          a.details.parentTurnIndex = matchingTurn.parentTurnIndex;
        }
      }
    }

    return { turns: sortedTurns, dag, clockSkewAnomalies };
  }

  private assignBranches(current: AgentTurn, allTurns: AgentTurn[]): void {
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
      this.assignBranches(child, allTurns);
    }
  }
}
