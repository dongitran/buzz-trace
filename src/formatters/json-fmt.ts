/**
 * JSON formatter for buzz-trace.
 * Outputs compact, structured JSON ideal for LLM prompts, subagents, and automated pipelines.
 */

import { Config } from "../config.js";
import { ThreadTelemetry } from "../models.js";

export interface JsonRenderOptions {
  compact?: boolean;
  config?: Config;
}

export class JsonRenderer {
  readonly indent: number;

  constructor(indent = 2) {
    this.indent = indent;
  }

  render(telemetry: ThreadTelemetry, options: JsonRenderOptions = {}): string {
    const isCompact = options.compact ?? false;

    if (isCompact) {
      const compactPayload = {
        thread_id: telemetry.threadId,
        status: telemetry.status,
        session_url: telemetry.phoenixSessionUrl || null,
        total_turns: telemetry.totalTurns,
        filtered_turns: telemetry.turns.length,
        ...(telemetry.anomalies.length > 0
          ? {
              anomalies: telemetry.anomalies.map((a) => ({
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
            status: t.statusCode,
            dur_s: Number((t.durationMs / 1000).toFixed(1)),
            tokens: t.totalTokens,
            trace_url: t.traceUrl || null,
            ...(hasError && t.statusMessage ? { error: t.statusMessage } : {}),
            ...(t.promptPreview ? { prompt: t.promptPreview.slice(0, 80) } : {}),
            ...(t.responsePreview ? { response: t.responsePreview.slice(0, 80) } : {}),
            ...(t.tools.length > 0
              ? {
                  tools: t.tools.map((tool) => ({
                    name: tool.name,
                    ok: tool.statusCode === "OK",
                    dur_ms: Math.round(tool.durationMs),
                    in: tool.inputSummary.slice(0, 80),
                    ...(tool.error ? { err: tool.error } : {}),
                  })),
                }
              : {}),
          };
        }),
      };
      return JSON.stringify(compactPayload, null, this.indent ? 2 : 0);
    }

    return JSON.stringify(telemetry.toJSON(), null, this.indent);
  }
}
