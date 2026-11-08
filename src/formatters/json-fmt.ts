/**
 * JSON formatter for buzz-trace.
 * Outputs compact, structured JSON ideal for LLM prompts, subagents, and automated pipelines.
 */

import { Config } from "../config.js";
import { ThreadTelemetry } from "../models.js";
import { formatCompactTool } from "./compact-fmt.js";

export interface JsonRenderOptions {
  compact?: boolean;
  flat?: boolean;
  config?: Config;
}

export class JsonRenderer {
  readonly indent: number;

  constructor(indent = 2) {
    this.indent = indent;
  }

  render(telemetry: ThreadTelemetry, options: JsonRenderOptions = {}): string {
    const isCompact = options.compact ?? false;
    const indent = options.flat || this.indent === 0 ? 0 : 2;

    if (isCompact) {
      // In compact mode (for LLM context protection):
      // Prune redundant anomalies whose details are already captured in turn.tools or turn.error
      const compactAnomalies = telemetry.anomalies.filter((a) => {
        if (
          a.type === "TOOL_ERROR" &&
          telemetry.turns.some((t) => (!a.turnIndex || t.turnIndex === a.turnIndex) && t.tools.some((tool) => tool.error || tool.statusCode !== "OK"))
        ) {
          return false;
        }
        if (
          a.type === "UNHANDLED_EXCEPTION" &&
          telemetry.turns.some((t) => (!a.turnIndex || t.turnIndex === a.turnIndex) && t.statusCode !== "OK")
        ) {
          return false;
        }
        return true;
      });

      const compactPayload = {
        thread_id: telemetry.threadId,
        status: telemetry.status,
        ...(!options.flat && telemetry.phoenixSessionUrl ? { session_url: telemetry.phoenixSessionUrl } : {}),
        total_turns: telemetry.totalTurns,
        filtered_turns: telemetry.turns.length,
        ...(telemetry.status === "NOT_FOUND" && telemetry.sourcesTried.length > 0
          ? { tried: telemetry.sourcesTried }
          : {}),
        ...(telemetry.totalCostUsd !== null && telemetry.totalCostUsd !== undefined
          ? { cost_usd: Number(telemetry.totalCostUsd.toFixed(4)) }
          : {}),
        ...(compactAnomalies.length > 0
          ? {
              anomalies: compactAnomalies.map((a) => ({
                type: a.type,
                turn: a.turnIndex ?? undefined,
                msg: a.message,
              })),
            }
          : {}),
        turns: telemetry.turns.map((t) => {
          const hasError = t.statusCode !== "OK";
          return {
            turn: t.turnIndex,
            agent: t.agentName,
            // The turn this one continues. `edge` is only said when that link is not exact (the default).
            ...(t.parentTurnIndex ? { parent: t.parentTurnIndex } : {}),
            // With steering a message that arrives mid-turn is answered by the running turn: say how many it handled.
            ...(t.steeredEventIds && t.steeredEventIds.length > 0 ? { msgs: 1 + t.steeredEventIds.length } : {}),
            ...(t.parentTurnIndex && t.parentEdgeType && t.parentEdgeType !== "REPLY_TO"
              ? { edge: t.parentEdgeType.toLowerCase() }
              : {}),
            status: t.statusCode,
            dur_s: Number((t.durationMs / 1000).toFixed(1)),
            tokens: t.totalTokens,
            // Tokens are summed over the turn's model calls; with more than one call, say how big one call's context was.
            ...(t.modelCalls && t.modelCalls > 1 && t.contextPerCall
              ? { calls: t.modelCalls, ctx: t.contextPerCall }
              : {}),
            ...(!options.flat && t.traceUrl ? { trace_url: t.traceUrl } : {}),
            ...(hasError && t.statusMessage ? { error: t.statusMessage } : {}),
            ...(t.promptPreview && !t.tools.some((tool) => tool.inputSummary === t.promptPreview)
              ? { prompt: t.promptPreview.slice(0, 80) }
              : {}),
            ...(t.responsePreview ? { response: t.responsePreview.slice(0, 80) } : {}),
            ...(t.tools.length > 0
              ? {
                  tools: t.tools.map((tool) => formatCompactTool(tool, 80)),
                }
              : {}),
          };
        }),
      };
      return JSON.stringify(compactPayload, null, indent);
    }

    return JSON.stringify(telemetry.toJSON(), null, indent);
  }
}
