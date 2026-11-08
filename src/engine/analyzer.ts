/**
 * Analytical intelligence and automated anomaly detector for thread telemetry.
 */

import { AgentTurn, Anomaly, ThreadTelemetry } from "../models.js";

export interface AnomalyDetectorOptions {
  tokenBloatThreshold?: number;
  slowTurnMs?: number;
  toolLoopThreshold?: number;
  tokenInflationMultiplier?: number;
  tokenInflationMinDelta?: number;
  slowToolMs?: number;
  /** An agent's context per call must grow by this factor, and by `contextGrowthMinDelta`, over its turns in a thread. */
  contextGrowthMultiplier?: number;
  contextGrowthMinDelta?: number;
}

/** The tokens one model call read: the turn's prompt tokens are summed over its calls, so judge the per-call size. */
function contextOf(turn: AgentTurn): number {
  return turn.contextPerCall ?? turn.promptTokens;
}

export class AnomalyDetector {
  readonly tokenBloatThreshold: number;
  readonly slowTurnMs: number;
  readonly toolLoopThreshold: number;
  readonly tokenInflationMultiplier: number;
  readonly tokenInflationMinDelta: number;
  readonly slowToolMs: number;
  readonly contextGrowthMultiplier: number;
  readonly contextGrowthMinDelta: number;

  constructor(options: AnomalyDetectorOptions = {}) {
    this.tokenBloatThreshold = options.tokenBloatThreshold ?? 150000;
    this.slowTurnMs = options.slowTurnMs ?? 60000;
    this.toolLoopThreshold = options.toolLoopThreshold ?? 3;
    this.tokenInflationMultiplier = options.tokenInflationMultiplier ?? 2.0;
    this.tokenInflationMinDelta = options.tokenInflationMinDelta ?? 15000;
    this.slowToolMs = options.slowToolMs ?? 5000;
    this.contextGrowthMultiplier = options.contextGrowthMultiplier ?? 2.0;
    this.contextGrowthMinDelta = options.contextGrowthMinDelta ?? 30000;
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
      const context = contextOf(turn);
      if (context >= this.tokenBloatThreshold) {
        const calls = turn.modelCalls ?? 1;
        anomalies.push({
          type: "TOKEN_BLOAT",
          severity: "WARNING",
          message:
            calls > 1
              ? `Excessive prompt context in Turn ${turn.turnIndex}: ~${context.toLocaleString()} tokens per model call (${turn.promptTokens.toLocaleString()} summed over ~${calls} calls; threshold: ${this.tokenBloatThreshold.toLocaleString()} per call).`
              : `Excessive prompt context in Turn ${turn.turnIndex}: ${turn.promptTokens.toLocaleString()} tokens (threshold: ${this.tokenBloatThreshold.toLocaleString()}).`,
          turnIndex: turn.turnIndex,
          traceId: turn.traceId,
          details: { promptTokens: turn.promptTokens, modelCalls: calls, contextPerCall: context },
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
      // An agent's prompt is mostly its own system prompt, tools and session: compare it with that agent's previous
      // turn when there is one. Another agent's turn (the parent, else the previous turn) is the fallback.
      let sameAgentPrev: AgentTurn | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (telemetry.turns[j].agentName === curr.agentName) {
          sameAgentPrev = telemetry.turns[j];
          break;
        }
      }
      const prev =
        sameAgentPrev ??
        (curr.parentTurnIndex
          ? telemetry.turns.find((t) => t.turnIndex === curr.parentTurnIndex) || telemetry.turns[i - 1]
          : telemetry.turns[i - 1]);

      if (prev && contextOf(prev) > 0) {
        // Per model call, not summed: a turn that made one more call than the last reads as 1.5x with nothing grown.
        const prevContext = contextOf(prev);
        const currContext = contextOf(curr);
        const ratio = currContext / prevContext;
        const delta = currContext - prevContext;
        if (ratio >= this.tokenInflationMultiplier && delta >= this.tokenInflationMinDelta) {
          anomalies.push({
            type: "TOKEN_INFLATION",
            severity: ratio >= 3.0 || delta >= 50000 ? "CRITICAL" : "WARNING",
            message: `Token inflation detected in Turn ${curr.turnIndex} (${curr.agentName}): prompt tokens grew ${ratio.toFixed(1)}x (+${delta.toLocaleString()} tokens) over Turn ${prev.turnIndex}.`,
            turnIndex: curr.turnIndex,
            traceId: curr.traceId,
            details: {
              prevTurnIndex: prev.turnIndex,
              prevTokens: prevContext,
              currTokens: currContext,
              ratio: Number(ratio.toFixed(2)),
              deltaTokens: delta,
            },
          });
        }
      }
    }

    // 8b. Context growth round after round: an agent's context per model call, first turn to last, in this thread.
    const byAgent = new Map<string, AgentTurn[]>();
    for (const turn of telemetry.turns) {
      const list = byAgent.get(turn.agentName) ?? [];
      list.push(turn);
      byAgent.set(turn.agentName, list);
    }
    for (const [agent, turns] of byAgent) {
      if (turns.length < 3) {
        continue;
      }
      const first = turns[0];
      const last = turns[turns.length - 1];
      const firstContext = contextOf(first);
      const lastContext = contextOf(last);
      if (firstContext <= 0) {
        continue;
      }
      const delta = lastContext - firstContext;
      if (lastContext / firstContext >= this.contextGrowthMultiplier && delta >= this.contextGrowthMinDelta) {
        const rounds = turns.length - 1;
        const perRound = Math.round(delta / rounds);
        // What a round adds that the spans show: the turn's own output, its tool results (~3.5 bytes a token) and the
        // next message. The rest of the growth is not in any span: it is sent again with each prompt.
        let visible = 0;
        for (let i = 0; i < rounds; i++) {
          const toolBytes = turns[i].tools.reduce((acc, tool) => acc + (tool.outputBytes || 0), 0);
          visible += turns[i].completionTokens + Math.round(toolBytes / 3.5) + (turns[i + 1].inputTextTokens ?? 0);
        }
        const explainedPerRound = Math.round(visible / rounds);
        const unexplainedPerRound = Math.max(0, perRound - explainedPerRound);
        const resent = unexplainedPerRound >= 5000 && unexplainedPerRound >= perRound / 2;
        anomalies.push({
          type: "CONTEXT_GROWTH",
          // Growth is a cost observation, not a failure (--failures lists WARNINGs): it warns only once the context is large.
          severity: lastContext >= this.tokenBloatThreshold / 2 ? "WARNING" : "INFO",
          message:
            `Context per model call of ${agent} grew from ~${firstContext.toLocaleString()} (Turn ${first.turnIndex}) to ` +
            `~${lastContext.toLocaleString()} (Turn ${last.turnIndex}), about +${perRound.toLocaleString()} a round. ` +
            (resent
              ? `Only ~${explainedPerRound.toLocaleString()} a round is visible in the spans (replies, tool results, new messages): ` +
                `~${unexplainedPerRound.toLocaleString()} a round is re-sent with every prompt, so check whether each prompt repeats a large static block.`
              : `Replies, tool results and new messages account for ~${explainedPerRound.toLocaleString()} a round: the conversation itself is growing.`),
          turnIndex: last.turnIndex,
          traceId: last.traceId,
          details: {
            agent,
            firstTurn: first.turnIndex,
            lastTurn: last.turnIndex,
            firstContext,
            lastContext,
            perRound,
            explainedPerRound,
            unexplainedPerRound,
            turns: turns.length,
          },
        });
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
