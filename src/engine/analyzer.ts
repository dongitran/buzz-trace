/**
 * Analytical intelligence and automated anomaly detector for thread telemetry.
 */

import { Anomaly, ThreadTelemetry } from "../models.js";

export interface AnomalyDetectorOptions {
  tokenBloatThreshold?: number;
  slowTurnMs?: number;
  toolLoopThreshold?: number;
  tokenInflationMultiplier?: number;
  tokenInflationMinDelta?: number;
  slowToolMs?: number;
}

export class AnomalyDetector {
  readonly tokenBloatThreshold: number;
  readonly slowTurnMs: number;
  readonly toolLoopThreshold: number;
  readonly tokenInflationMultiplier: number;
  readonly tokenInflationMinDelta: number;
  readonly slowToolMs: number;

  constructor(options: AnomalyDetectorOptions = {}) {
    this.tokenBloatThreshold = options.tokenBloatThreshold ?? 150000;
    this.slowTurnMs = options.slowTurnMs ?? 60000;
    this.toolLoopThreshold = options.toolLoopThreshold ?? 3;
    this.tokenInflationMultiplier = options.tokenInflationMultiplier ?? 2.0;
    this.tokenInflationMinDelta = options.tokenInflationMinDelta ?? 15000;
    this.slowToolMs = options.slowToolMs ?? 5000;
  }

  analyze(telemetry: ThreadTelemetry): Anomaly[] {
    const anomalies: Anomaly[] = [...(telemetry.anomalies || [])];

    for (const turn of telemetry.turns) {
      // 0. Invalid Span Duration Check (monotonic clock jumps backward)
      for (const span of turn.spans) {
        if (span.startTime && span.endTime && span.startTime.getTime() > span.endTime.getTime()) {
          const alreadyExists = anomalies.some(
            (a) => a.type === "INVALID_DURATION" && a.details?.spanId === span.spanId,
          );
          if (!alreadyExists) {
            const negativeMs = span.startTime.getTime() - span.endTime.getTime();
            anomalies.push({
              type: "INVALID_DURATION",
              severity: "WARNING",
              message: `Invalid span duration detected: span '${span.name}' has startTime (${span.startTime.toISOString()}) later than endTime (${span.endTime.toISOString()}) by ${negativeMs}ms due to monotonic clock jump.`,
              turnIndex: turn.turnIndex,
              traceId: turn.traceId,
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
      }

      // 1. Context Canceled Check
      const msg = (turn.statusMessage || "").toLowerCase();
      let isCanceled = false;
      if (
        msg.includes("context canceled") ||
        msg.includes("canceled") ||
        msg.includes("aborted") ||
        turn.spans.some((s) => s.attributes["agy.stop_reason"] === "cancelled")
      ) {
        isCanceled = true;
        anomalies.push({
          type: "CONTEXT_CANCELED",
          severity: "CRITICAL",
          message: `Turn ${turn.turnIndex} was prematurely aborted with context cancellation.`,
          turnIndex: turn.turnIndex,
          traceId: turn.traceId,
          details: { statusMessage: turn.statusMessage },
        });
      }

      // 2. Unhandled Agent Exception Check
      if (turn.statusCode === "ERROR" && !isCanceled) {
        let failureKind: string | null = null;
        let exceptionMsg: string | null = null;
        for (const span of turn.spans) {
          if (span.attributes["agy.failure_kind"]) {
            failureKind = String(span.attributes["agy.failure_kind"]);
          }
          if (span.attributes["exception.message"]) {
            exceptionMsg = String(span.attributes["exception.message"]);
          }
        }
        const errSummary = turn.statusMessage || exceptionMsg || failureKind || "Turn finished with ERROR status";
        anomalies.push({
          type: "UNHANDLED_EXCEPTION",
          severity: "CRITICAL",
          message: `Unhandled agent failure in Turn ${turn.turnIndex} (${turn.agentName}): ${errSummary}`,
          turnIndex: turn.turnIndex,
          traceId: turn.traceId,
          details: {
            agentName: turn.agentName,
            statusMessage: turn.statusMessage,
            failureKind,
            exceptionMessage: exceptionMsg,
          },
        });
      }

      // 3. Tool Errors Check
      for (const tool of turn.tools) {
        if (tool.statusCode === "ERROR" || tool.error) {
          anomalies.push({
            type: "TOOL_ERROR",
            severity: "WARNING",
            message: `Tool '${tool.name}' failed in Turn ${turn.turnIndex}: ${tool.error || "Non-zero status"}`,
            turnIndex: turn.turnIndex,
            traceId: turn.traceId,
            details: { toolName: tool.name, error: tool.error },
          });
        }
      }

      // 4. Tool Loop Check (repeated consecutive identical tool calls)
      if (turn.tools.length >= this.toolLoopThreshold) {
        let consecutive = 1;
        for (let i = 1; i < turn.tools.length; i++) {
          const prev = turn.tools[i - 1];
          const curr = turn.tools[i];
          if (prev.name === curr.name && prev.inputSummary === curr.inputSummary && curr.inputSummary) {
            consecutive++;
            if (consecutive >= this.toolLoopThreshold) {
              anomalies.push({
                type: "TOOL_LOOP",
                severity: "CRITICAL",
                message: `Tool loop detected: '${curr.name}' invoked ${consecutive} times with identical arguments in Turn ${turn.turnIndex}.`,
                turnIndex: turn.turnIndex,
                traceId: turn.traceId,
                details: { toolName: curr.name, count: consecutive },
              });
              break;
            }
          } else {
            consecutive = 1;
          }
        }
      }

      // 5. Slow Tool Check (per-tool latency spike >= slowToolMs)
      for (const tool of turn.tools) {
        if (tool.durationMs >= this.slowToolMs) {
          anomalies.push({
            type: "SLOW_TOOL",
            severity: tool.durationMs >= 15000 ? "CRITICAL" : "WARNING",
            message: `Slow tool execution: '${tool.name}' took ${(tool.durationMs / 1000).toFixed(2)}s in Turn ${turn.turnIndex} (threshold: ${(this.slowToolMs / 1000).toFixed(1)}s).`,
            turnIndex: turn.turnIndex,
            traceId: turn.traceId,
            details: { toolName: tool.name, durationMs: tool.durationMs, spanId: tool.spanId },
          });
        }
      }

      // 6. Token Bloat Check
      if (turn.promptTokens >= this.tokenBloatThreshold) {
        anomalies.push({
          type: "TOKEN_BLOAT",
          severity: "WARNING",
          message: `Excessive prompt context in Turn ${turn.turnIndex}: ${turn.promptTokens.toLocaleString()} tokens (threshold: ${this.tokenBloatThreshold.toLocaleString()}).`,
          turnIndex: turn.turnIndex,
          traceId: turn.traceId,
          details: { promptTokens: turn.promptTokens },
        });
      }

      // 7. Latency Spike Check
      if (turn.durationMs >= this.slowTurnMs) {
        anomalies.push({
          type: "LATENCY_SPIKE",
          severity: "INFO",
          message: `Slow turn execution: Turn ${turn.turnIndex} took ${(turn.durationMs / 1000).toFixed(1)}s (threshold: ${(this.slowTurnMs / 1000).toFixed(0)}s).`,
          turnIndex: turn.turnIndex,
          traceId: turn.traceId,
          details: { durationMs: turn.durationMs },
        });
      }
    }

    // 8. Cross-Turn Token Inflation Check (exponential token growth between turns)
    for (let i = 1; i < telemetry.turns.length; i++) {
      const curr = telemetry.turns[i];
      const prev = curr.parentTurnIndex
        ? telemetry.turns.find((t) => t.turnIndex === curr.parentTurnIndex) || telemetry.turns[i - 1]
        : telemetry.turns[i - 1];

      if (prev && prev.promptTokens > 0) {
        const ratio = curr.promptTokens / prev.promptTokens;
        const delta = curr.promptTokens - prev.promptTokens;
        if (ratio >= this.tokenInflationMultiplier && delta >= this.tokenInflationMinDelta) {
          anomalies.push({
            type: "TOKEN_INFLATION",
            severity: ratio >= 3.0 || delta >= 50000 ? "CRITICAL" : "WARNING",
            message: `Token inflation detected in Turn ${curr.turnIndex} (${curr.agentName}): prompt tokens grew ${ratio.toFixed(1)}x (+${delta.toLocaleString()} tokens) over Turn ${prev.turnIndex}.`,
            turnIndex: curr.turnIndex,
            traceId: curr.traceId,
            details: {
              prevTurnIndex: prev.turnIndex,
              prevTokens: prev.promptTokens,
              currTokens: curr.promptTokens,
              ratio: Number(ratio.toFixed(2)),
              deltaTokens: delta,
            },
          });
        }
      }
    }

    // 9. Thread-wide Slow Tool P95 Latency Spike Check
    const allToolDurations: number[] = [];
    for (const turn of telemetry.turns) {
      for (const tool of turn.tools) {
        allToolDurations.push(tool.durationMs);
      }
    }
    if (allToolDurations.length >= 5) {
      allToolDurations.sort((a, b) => a - b);
      const p95Idx = Math.ceil(0.95 * allToolDurations.length) - 1;
      const p95 = allToolDurations[p95Idx];
      if (p95 >= this.slowToolMs) {
        anomalies.push({
          type: "SLOW_TOOL",
          severity: "WARNING",
          message: `Thread tool execution latency P95 spike: ${(p95 / 1000).toFixed(2)}s across ${allToolDurations.length} tool calls (threshold: ${(this.slowToolMs / 1000).toFixed(1)}s).`,
          details: { p95DurationMs: p95, totalToolCalls: allToolDurations.length },
        });
      }
    }

    telemetry.anomalies = anomalies;
    return anomalies;
  }
}
