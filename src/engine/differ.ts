/**
 * Trace & Turn Diff Engine for buzz-trace.
 * Compares two agent turns/traces and produces high-density diffs for AI agents and human operators.
 */

import { AgentTurn, ThreadTelemetry } from "../models.js";

export interface ToolDiffItem {
  index: number;
  name: string;
  status_a: string | null;
  status_b: string | null;
  dur_ms_a: number | null;
  dur_ms_b: number | null;
  delta_ms: number | null;
  error_a: string | null;
  error_b: string | null;
  changed: boolean;
}

export interface TraceDiffTargetMeta {
  identifier: string;
  trace_id: string;
  thread_id?: string;
  turn_index?: number;
  agent: string;
  model: string;
  status: string;
  duration_ms: number;
  total_tokens: number;
}

export interface TraceDiffResult {
  target_a: TraceDiffTargetMeta;
  target_b: TraceDiffTargetMeta;
  diff: {
    model: {
      a: string;
      b: string;
      changed: boolean;
    };
    duration_ms: {
      a: number;
      b: number;
      delta_ms: number;
      pct_change: number;
    };
    tokens: {
      total: {
        a: number;
        b: number;
        delta_tokens: number;
        pct_change: number;
      };
      prompt: {
        a: number;
        b: number;
        delta_tokens: number;
      };
      completion: {
        a: number;
        b: number;
        delta_tokens: number;
      };
      reasoning: {
        a: number;
        b: number;
        delta_tokens: number;
      };
    };
    /** The prompt tokens of one model call (estimated), when both turns have it: the totals above are summed over calls. */
    context_per_call?: {
      a: number;
      b: number;
      delta_tokens: number;
      pct_change: number;
    };
    model_calls?: {
      a: number;
      b: number;
      delta_count: number;
    };
    tools: {
      count: {
        a: number;
        b: number;
        delta_count: number;
      };
      status_diff: ToolDiffItem[];
    };
  };
}

export class TraceDiffer {
  /**
   * Compares two AgentTurn instances and generates a structured diff.
   */
  diff(
    turnA: AgentTurn,
    turnB: AgentTurn,
    metaA?: Partial<TraceDiffTargetMeta>,
    metaB?: Partial<TraceDiffTargetMeta>,
  ): TraceDiffResult {
    const targetA: TraceDiffTargetMeta = {
      identifier: metaA?.identifier || turnA.traceId,
      trace_id: turnA.traceId,
      thread_id: metaA?.thread_id,
      turn_index: turnA.turnIndex,
      agent: turnA.agentName || "unknown",
      model: turnA.modelName || "unknown",
      status: turnA.statusCode || "OK",
      duration_ms: turnA.durationMs,
      total_tokens: turnA.totalTokens,
    };

    const targetB: TraceDiffTargetMeta = {
      identifier: metaB?.identifier || turnB.traceId,
      trace_id: turnB.traceId,
      thread_id: metaB?.thread_id,
      turn_index: turnB.turnIndex,
      agent: turnB.agentName || "unknown",
      model: turnB.modelName || "unknown",
      status: turnB.statusCode || "OK",
      duration_ms: turnB.durationMs,
      total_tokens: turnB.totalTokens,
    };

    const deltaDuration = targetB.duration_ms - targetA.duration_ms;
    const durPctChange =
      targetA.duration_ms > 0
        ? Number((((targetB.duration_ms - targetA.duration_ms) / targetA.duration_ms) * 100).toFixed(2))
        : 0;

    const deltaTotalTokens = targetB.total_tokens - targetA.total_tokens;
    const tokPctChange =
      targetA.total_tokens > 0
        ? Number((((targetB.total_tokens - targetA.total_tokens) / targetA.total_tokens) * 100).toFixed(2))
        : 0;

    const deltaPromptTokens = (turnB.promptTokens || 0) - (turnA.promptTokens || 0);
    const deltaCompletionTokens = (turnB.completionTokens || 0) - (turnA.completionTokens || 0);
    const deltaReasoningTokens = (turnB.reasoningTokens || 0) - (turnA.reasoningTokens || 0);

    const toolsA = turnA.tools || [];
    const toolsB = turnB.tools || [];
    const maxTools = Math.max(toolsA.length, toolsB.length);
    const toolDiffs: ToolDiffItem[] = [];

    for (let i = 0; i < maxTools; i++) {
      const toolA = toolsA[i] || null;
      const toolB = toolsB[i] || null;

      const name = toolB?.name || toolA?.name || `tool_${i + 1}`;
      const statusA = toolA?.statusCode || null;
      const statusB = toolB?.statusCode || null;
      const durA = toolA ? toolA.durationMs : null;
      const durB = toolB ? toolB.durationMs : null;
      const deltaMs = durA !== null && durB !== null ? durB - durA : null;
      const errA = toolA?.error || null;
      const errB = toolB?.error || null;

      const changed =
        statusA !== statusB ||
        toolA?.name !== toolB?.name ||
        errA !== errB ||
        (toolA === null && toolB !== null) ||
        (toolA !== null && toolB === null);

      toolDiffs.push({
        index: i + 1,
        name,
        status_a: statusA,
        status_b: statusB,
        dur_ms_a: durA,
        dur_ms_b: durB,
        delta_ms: deltaMs,
        error_a: errA,
        error_b: errB,
        changed,
      });
    }

    return {
      target_a: targetA,
      target_b: targetB,
      diff: {
        model: {
          a: targetA.model,
          b: targetB.model,
          changed: targetA.model !== targetB.model,
        },
        duration_ms: {
          a: targetA.duration_ms,
          b: targetB.duration_ms,
          delta_ms: deltaDuration,
          pct_change: durPctChange,
        },
        tokens: {
          total: {
            a: targetA.total_tokens,
            b: targetB.total_tokens,
            delta_tokens: deltaTotalTokens,
            pct_change: tokPctChange,
          },
          prompt: {
            a: turnA.promptTokens || 0,
            b: turnB.promptTokens || 0,
            delta_tokens: deltaPromptTokens,
          },
          completion: {
            a: turnA.completionTokens || 0,
            b: turnB.completionTokens || 0,
            delta_tokens: deltaCompletionTokens,
          },
          reasoning: {
            a: turnA.reasoningTokens || 0,
            b: turnB.reasoningTokens || 0,
            delta_tokens: deltaReasoningTokens,
          },
        },
        ...(turnA.contextPerCall && turnB.contextPerCall
          ? {
              context_per_call: {
                a: turnA.contextPerCall,
                b: turnB.contextPerCall,
                delta_tokens: turnB.contextPerCall - turnA.contextPerCall,
                pct_change: Number((((turnB.contextPerCall - turnA.contextPerCall) / turnA.contextPerCall) * 100).toFixed(2)),
              },
              model_calls: {
                a: turnA.modelCalls ?? 1,
                b: turnB.modelCalls ?? 1,
                delta_count: (turnB.modelCalls ?? 1) - (turnA.modelCalls ?? 1),
              },
            }
          : {}),
        tools: {
          count: {
            a: toolsA.length,
            b: toolsB.length,
            delta_count: toolsB.length - toolsA.length,
          },
          status_diff: toolDiffs,
        },
      },
    };
  }

  /**
   * Resolves target reference (traceId, thread#turn, or thread) from telemetry fetcher.
   */
  static resolveTurnFromTelemetry(
    telemetry: ThreadTelemetry,
    identifier: string,
    requestedTurnIndex?: number,
  ): { turn: AgentTurn; meta: TraceDiffTargetMeta } {
    if (telemetry.turns.length === 0) {
      throw new Error(`No turns found for identifier: ${identifier}`);
    }

    let turn: AgentTurn | undefined;

    // 1. Explicit turn index request
    if (requestedTurnIndex !== undefined) {
      turn = telemetry.turns.find((t) => t.turnIndex === requestedTurnIndex);
      if (!turn) {
        throw new Error(`Turn index ${requestedTurnIndex} not found in thread (available: 1..${telemetry.turns.length})`);
      }
    }

    // 2. Direct trace ID matching
    if (!turn && /^[0-9a-fA-F]{32}$/.test(identifier)) {
      turn = telemetry.turns.find((t) => t.traceId.toLowerCase() === identifier.toLowerCase());
    }

    // 3. Fallback to latest turn or turn 1
    if (!turn) {
      turn = telemetry.turns[telemetry.turns.length - 1];
    }

    const meta: TraceDiffTargetMeta = {
      identifier,
      trace_id: turn.traceId,
      thread_id: telemetry.threadId,
      turn_index: turn.turnIndex,
      agent: turn.agentName,
      model: turn.modelName,
      status: turn.statusCode,
      duration_ms: turn.durationMs,
      total_tokens: turn.totalTokens,
    };

    return { turn, meta };
  }

  /**
   * Renders diff output for terminal.
   */
  static renderTerminal(result: TraceDiffResult, useColor = true): string {
    const c = {
      reset: useColor ? "\x1b[0m" : "",
      bold: useColor ? "\x1b[1m" : "",
      dim: useColor ? "\x1b[2m" : "",
      red: useColor ? "\x1b[31m" : "",
      green: useColor ? "\x1b[32m" : "",
      yellow: useColor ? "\x1b[33m" : "",
      cyan: useColor ? "\x1b[36m" : "",
      magenta: useColor ? "\x1b[35m" : "",
    };

    const fmtDelta = (val: number, unit = "", isLatency = false) => {
      const sign = val > 0 ? "+" : "";
      const text = `${sign}${val.toLocaleString()}${unit}`;
      if (val === 0) {return `${c.dim}${text}${c.reset}`;}
      // For latency, negative (faster) is green, positive (slower) is red
      if (isLatency) {
        return val < 0 ? `${c.green}${text}${c.reset}` : `${c.red}${text}${c.reset}`;
      }
      return val > 0 ? `${c.yellow}${text}${c.reset}` : `${c.cyan}${text}${c.reset}`;
    };

    const lines: string[] = [];
    lines.push(`${c.bold}TRACE EXECUTION DIFF${c.reset}`);
    lines.push("=".repeat(80));
    lines.push(
      `Target A: ${c.cyan}${result.target_a.identifier}${c.reset} (Turn #${result.target_a.turn_index}, Agent: ${result.target_a.agent}, Trace: ${result.target_a.trace_id.slice(0, 8)}…)`,
    );
    lines.push(
      `Target B: ${c.magenta}${result.target_b.identifier}${c.reset} (Turn #${result.target_b.turn_index}, Agent: ${result.target_b.agent}, Trace: ${result.target_b.trace_id.slice(0, 8)}…)`,
    );
    lines.push("-".repeat(80));

    // Model diff
    const modelDiff = result.diff.model;
    const modelNote = modelDiff.changed ? ` ${c.yellow}[CHANGED]${c.reset}` : ` ${c.dim}[MATCH]${c.reset}`;
    lines.push(
      `Model:              ${result.target_a.model} -> ${result.target_b.model}${modelNote}`,
    );

    // Duration diff
    const durDiff = result.diff.duration_ms;
    const durPct = durDiff.pct_change > 0 ? `+${durDiff.pct_change}%` : `${durDiff.pct_change}%`;
    lines.push(
      `Duration:           ${durDiff.a.toLocaleString()}ms -> ${durDiff.b.toLocaleString()}ms (Δ ${fmtDelta(durDiff.delta_ms, "ms", true)}, ${durPct})`,
    );

    // Token diff
    const tokDiff = result.diff.tokens;
    const tokPct = tokDiff.total.pct_change > 0 ? `+${tokDiff.total.pct_change}%` : `${tokDiff.total.pct_change}%`;
    lines.push(
      `Total Tokens:       ${tokDiff.total.a.toLocaleString()} -> ${tokDiff.total.b.toLocaleString()} (Δ ${fmtDelta(tokDiff.total.delta_tokens, " tok")}, ${tokPct})`,
    );
    lines.push(
      `  ├── Prompt:       ${tokDiff.prompt.a.toLocaleString()} -> ${tokDiff.prompt.b.toLocaleString()} (Δ ${fmtDelta(tokDiff.prompt.delta_tokens)})`,
    );
    lines.push(
      `  └── Completion:   ${tokDiff.completion.a.toLocaleString()} -> ${tokDiff.completion.b.toLocaleString()} (Δ ${fmtDelta(tokDiff.completion.delta_tokens)})`,
    );

    const ctxDiff = result.diff.context_per_call;
    if (ctxDiff) {
      lines.push(
        `Context/call:      ${ctxDiff.a.toLocaleString()} -> ${ctxDiff.b.toLocaleString()} (Δ ${fmtDelta(ctxDiff.delta_tokens)}, ~per model call)`,
      );
    }

    // Tool executions
    const toolDiff = result.diff.tools;
    lines.push(
      `Tool Executions:    ${toolDiff.count.a} -> ${toolDiff.count.b} (Δ ${fmtDelta(toolDiff.count.delta_count)})`,
    );

    if (toolDiff.status_diff.length > 0) {
      lines.push("\nTool Execution Status Diff:");
      for (const t of toolDiff.status_diff) {
        const changeTag = t.changed ? `${c.yellow}[DIFF]${c.reset}` : `${c.dim}[SAME]${c.reset}`;
        const statusTransition = `${t.status_a || "NONE"} -> ${t.status_b || "NONE"}`;
        const errorNote = t.error_b ? ` | Error B: ${c.red}${t.error_b}${c.reset}` : "";
        lines.push(`  #${t.index} ${changeTag} ${c.bold}${t.name}${c.reset}: ${statusTransition}${errorNote}`);
      }
    }

    lines.push("=".repeat(80));
    return lines.join("\n");
  }
}
