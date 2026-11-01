/**
 * Analytical intelligence and automated anomaly detector for thread telemetry.
 */

import { Anomaly, ThreadTelemetry } from "../models.js";

export interface AnomalyDetectorOptions {
  tokenBloatThreshold?: number;
  slowTurnMs?: number;
  toolLoopThreshold?: number;
}

export class AnomalyDetector {
  readonly tokenBloatThreshold: number;
  readonly slowTurnMs: number;
  readonly toolLoopThreshold: number;

  constructor(options: AnomalyDetectorOptions = {}) {
    this.tokenBloatThreshold = options.tokenBloatThreshold ?? 150000;
    this.slowTurnMs = options.slowTurnMs ?? 60000;
    this.toolLoopThreshold = options.toolLoopThreshold ?? 3;
  }

  analyze(telemetry: ThreadTelemetry): Anomaly[] {
    const anomalies: Anomaly[] = [];

    for (const turn of telemetry.turns) {
      // 1. Context Canceled Check
      const msg = (turn.statusMessage || "").toLowerCase();
      if (msg.includes("context canceled") || msg.includes("canceled") || msg.includes("aborted")) {
        anomalies.push({
          type: "CONTEXT_CANCELED",
          severity: "CRITICAL",
          message: `Turn ${turn.turnIndex} was prematurely aborted with context cancellation.`,
          turnIndex: turn.turnIndex,
          traceId: turn.traceId,
          details: { statusMessage: turn.statusMessage },
        });
      }

      // 2. Tool Errors Check
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

      // 3. Tool Loop Check (repeated consecutive identical tool calls)
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

      // 4. Token Bloat Check
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

      // 5. Latency Spike Check
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

    telemetry.anomalies = anomalies;
    return anomalies;
  }
}
