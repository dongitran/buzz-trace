/**
 * Thread Telemetry Query and Filter Engine.
 * Enables AI agents and developers to query and filter conversation history efficiently.
 */

import { Anomaly, ThreadTelemetry } from "../models.js";

export interface QueryFilterOptions {
  failuresOnly?: boolean;
  toolsOnly?: boolean;
  toolName?: string;
  toolInput?: string;
  agentFilter?: string;
  lastN?: number;
  targetTurn?: number;
}

export class ThreadQueryEngine {
  filter(telemetry: ThreadTelemetry, options: QueryFilterOptions): ThreadTelemetry {
    let filteredTurns = [...telemetry.turns];

    // 1. Filter by specific turn
    if (options.targetTurn !== undefined && options.targetTurn > 0) {
      filteredTurns = filteredTurns.filter((t) => t.turnIndex === options.targetTurn);
    }

    // 2. Filter by Agent name (case-insensitive substring)
    if (options.agentFilter) {
      const q = options.agentFilter.toLowerCase();
      filteredTurns = filteredTurns.filter((t) => t.agentName.toLowerCase().includes(q));
    }

    // 3. Filter by failures only
    if (options.failuresOnly) {
      filteredTurns = filteredTurns
        .filter((turn) => {
          const hasTurnError = turn.statusCode !== "OK";
          const hasToolError = turn.tools.some((tool) => tool.statusCode !== "OK" || Boolean(tool.error));
          const hasAnomaly = telemetry.anomalies.some(
            (a) => a.turnIndex === turn.turnIndex && a.severity !== "INFO",
          );
          return hasTurnError || hasToolError || hasAnomaly;
        })
        .map((turn) => {
          // In failures-only mode, prune successful tools so that turns with dozens of tools don't bloat LLM context!
          const failedTools = turn.tools.filter((tool) => tool.statusCode !== "OK" || Boolean(tool.error));
          return {
            ...turn,
            tools: failedTools.length > 0 ? failedTools : (turn.statusCode !== "OK" ? [] : turn.tools),
          };
        });
    }

    // 4. Filter by tools
    if (options.toolsOnly || options.toolName || options.toolInput) {
      filteredTurns = filteredTurns.filter((turn) => {
        if (turn.tools.length === 0) {
          return false;
        }
        if (options.toolName) {
          const matchName = options.toolName.toLowerCase();
          if (!turn.tools.some((tool) => tool.name.toLowerCase().includes(matchName))) {
            return false;
          }
        }
        if (options.toolInput) {
          const matchInput = options.toolInput.toLowerCase();
          if (!turn.tools.some((tool) => tool.inputSummary.toLowerCase().includes(matchInput))) {
            return false;
          }
        }
        return true;
      });
    }

    // 5. Slice last N turns
    if (options.lastN !== undefined && options.lastN > 0) {
      filteredTurns = filteredTurns.slice(-options.lastN);
    }

    // Filter corresponding anomalies
    const turnIndices = new Set(filteredTurns.map((t) => t.turnIndex));
    const filteredAnomalies: Anomaly[] = telemetry.anomalies.filter(
      (a) => a.turnIndex === null || a.turnIndex === undefined || turnIndices.has(a.turnIndex),
    );

    const costed = filteredTurns.filter((t) => t.costUsd !== undefined);
    const filteredCost = costed.length > 0 ? costed.reduce((acc, t) => acc + (t.costUsd ?? 0), 0) : null;

    return new ThreadTelemetry({
      threadId: telemetry.threadId,
      project: telemetry.project,
      sessionId: telemetry.sessionId,
      nostrThreadId: telemetry.nostrThreadId,
      nostrChannelId: telemetry.nostrChannelId,
      phoenixUiUrl: telemetry.phoenixUiUrl,
      phoenixSessionUrl: telemetry.phoenixSessionUrl,
      totalTurns: telemetry.totalTurns,
      totalTokens: filteredTurns.reduce((acc, t) => acc + t.totalTokens, 0),
      totalPromptTokens: filteredTurns.reduce((acc, t) => acc + t.promptTokens, 0),
      totalCompletionTokens: filteredTurns.reduce((acc, t) => acc + t.completionTokens, 0),
      totalDurationMs: filteredTurns.reduce((acc, t) => acc + t.durationMs, 0),
      totalCostUsd: filteredCost,
      source: telemetry.source,
      sourcesTried: telemetry.sourcesTried,
      startTime: filteredTurns.length > 0 ? filteredTurns[0].startTime : telemetry.startTime,
      endTime: filteredTurns.length > 0 ? filteredTurns[filteredTurns.length - 1].endTime : telemetry.endTime,
      status: filteredTurns.some((t) => t.statusCode !== "OK") ? "ERROR" : telemetry.status,
      turns: filteredTurns,
      anomalies: filteredAnomalies,
    });
  }
}
