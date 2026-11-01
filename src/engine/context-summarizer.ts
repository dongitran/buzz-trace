/**
 * Adaptive Context Summarizer for Autonomous AI Agents.
 * Auto-trims multi-agent thread history to fit within a strict token budget (e.g. 200 or 500 tokens).
 *
 * Prioritization Hierarchy:
 *   Priority 1: Root Intent (Turn 1 prompt / user request)
 *   Priority 2: Latest Turn Outcome (Final turn agent response & status)
 *   Priority 3: Failed Tools & Anomalies (Errors encountered during execution)
 *   Pruned: Successful intermediate chatter and redundant tool previews.
 */

import { ThreadTelemetry } from "../models.js";
import { countTokens } from "../tokenizer.js";

export interface FailedToolSummary {
  turn: number;
  agent: string;
  name: string;
  status: string;
  error: string;
  input?: string;
}

export interface LatestTurnOutcome {
  turn: number;
  agent: string;
  status: string;
  response: string;
  tools_count: number;
}

export interface ThreadContextSummary {
  thread_id: string;
  status: string;
  budget: number;
  actual_tokens: number;
  total_turns: number;
  pruned_turns: number;
  root_intent: string;
  latest_outcome: LatestTurnOutcome;
  failed_tools: FailedToolSummary[];
  intermediate_notes?: string;
}

export interface SummarizeOptions {
  budget?: number; // Target token limit (default: 500)
  flat?: boolean;   // Output single-line unindented JSON
}

export class ContextSummarizer {
  /**
   * Summarizes a thread telemetry object to fit within a strict token budget.
   */
  summarize(telemetry: ThreadTelemetry, options: SummarizeOptions = {}): ThreadContextSummary {
    const budget = options.budget && options.budget > 0 ? options.budget : 500;
    const turns = telemetry.turns || [];

    if (turns.length === 0) {
      const emptySummary: ThreadContextSummary = {
        thread_id: telemetry.threadId,
        status: telemetry.status || "UNKNOWN",
        budget,
        actual_tokens: 0,
        total_turns: 0,
        pruned_turns: 0,
        root_intent: "",
        latest_outcome: {
          turn: 0,
          agent: "none",
          status: "EMPTY",
          response: "",
          tools_count: 0,
        },
        failed_tools: [],
      };
      emptySummary.actual_tokens = countTokens(
        options.flat ? JSON.stringify(emptySummary) : JSON.stringify(emptySummary, null, 2),
      );
      return emptySummary;
    }

    // 1. Extract Priority 1: Root Intent (Turn 1 prompt)
    const turn1 = turns[0];
    const rootIntent = (turn1.promptPreview || "").trim();

    // 2. Extract Priority 2: Latest Turn Outcome (Last Turn)
    const lastTurn = turns[turns.length - 1];
    const latestResponse = (lastTurn.responsePreview || "").trim();

    // 3. Extract Priority 3: Failed Tools across the entire thread
    const failedTools: FailedToolSummary[] = [];
    for (const t of turns) {
      for (const tool of t.tools) {
        if (tool.statusCode !== "OK" || tool.error) {
          failedTools.push({
            turn: t.turnIndex,
            agent: t.agentName,
            name: tool.name,
            status: tool.statusCode,
            error: (tool.error || "Tool failed with non-zero exit code").trim(),
            input: tool.inputSummary ? tool.inputSummary.trim() : undefined,
          });
        }
      }
    }

    // Intermediate turns pruned: all turns between turn 1 and lastTurn that didn't fail
    const prunedTurnsCount = turns.length > 2 ? turns.length - 2 : 0;

    const latestOutcome: LatestTurnOutcome = {
      turn: lastTurn.turnIndex,
      agent: lastTurn.agentName,
      status: lastTurn.statusCode,
      response: latestResponse,
      tools_count: lastTurn.tools.length,
    };

    // Construct base payload
    const summary: ThreadContextSummary = {
      thread_id: telemetry.threadId,
      status: telemetry.status,
      budget,
      actual_tokens: 0,
      total_turns: turns.length,
      pruned_turns: prunedTurnsCount,
      root_intent: rootIntent,
      latest_outcome: latestOutcome,
      failed_tools: failedTools,
    };

    const serialize = (s: ThreadContextSummary): string =>
      options.flat ? JSON.stringify(s) : JSON.stringify(s, null, 2);

    let currentTokens = countTokens(serialize(summary));

    // If budget allows and there is remaining room, add intermediate context notes
    if (currentTokens < budget - 40 && prunedTurnsCount > 0) {
      summary.intermediate_notes = `Pruned ${prunedTurnsCount} intermediate successful turns (turns 2..${lastTurn.turnIndex - 1}).`;
      currentTokens = countTokens(serialize(summary));
    }

    // 4. Adaptive Trimming Loop: if currentTokens > budget, progressively truncate strings
    if (currentTokens > budget) {
      // Step A: Remove intermediate_notes if present
      if (summary.intermediate_notes) {
        delete summary.intermediate_notes;
        currentTokens = countTokens(serialize(summary));
      }

      // Step B: Strip input from failed tools if still over budget
      if (currentTokens > budget && summary.failed_tools.length > 0) {
        for (const ft of summary.failed_tools) {
          delete ft.input;
        }
        currentTokens = countTokens(serialize(summary));
      }

      // Step C: Binary search / proportional trimming of text fields:
      // Text fields to trim: root_intent, latest_outcome.response, and failed_tools errors
      let maxLen = 300;
      while (currentTokens > budget && maxLen > 20) {
        maxLen = Math.floor(maxLen * 0.75);

        if (summary.root_intent.length > maxLen) {
          summary.root_intent = summary.root_intent.slice(0, maxLen).trim() + "…";
        }
        if (summary.latest_outcome.response.length > maxLen) {
          summary.latest_outcome.response = summary.latest_outcome.response.slice(0, maxLen).trim() + "…";
        }
        for (const ft of summary.failed_tools) {
          if (ft.error.length > maxLen) {
            ft.error = ft.error.slice(0, maxLen).trim() + "…";
          }
        }

        currentTokens = countTokens(serialize(summary));
      }

      // Final strict fallback: if still slightly over budget, truncate response further
      if (currentTokens > budget) {
        let hardCap = 40;
        while (currentTokens > budget && hardCap >= 5) {
          summary.root_intent = summary.root_intent.slice(0, hardCap) + "…";
          summary.latest_outcome.response = summary.latest_outcome.response.slice(0, hardCap) + "…";
          currentTokens = countTokens(serialize(summary));
          hardCap -= 5;
        }
      }
    }

    summary.actual_tokens = currentTokens;
    return summary;
  }

  /**
   * Formats the summary as a string (flat JSON, indented JSON, or terminal format).
   */
  static render(summary: ThreadContextSummary, options: { flat?: boolean; json?: boolean; noColor?: boolean } = {}): string {
    if (options.flat) {
      return JSON.stringify(summary);
    }
    if (options.json) {
      return JSON.stringify(summary, null, 2);
    }

    // Terminal human-readable presentation
    const useColor = !options.noColor;
    const c = {
      reset: useColor ? "\x1b[0m" : "",
      bold: useColor ? "\x1b[1m" : "",
      dim: useColor ? "\x1b[2m" : "",
      red: useColor ? "\x1b[31m" : "",
      green: useColor ? "\x1b[32m" : "",
      yellow: useColor ? "\x1b[33m" : "",
      cyan: useColor ? "\x1b[36m" : "",
    };

    const lines: string[] = [];
    lines.push(`${c.bold}BUZZ-TRACE ADAPTIVE CONTEXT SUMMARY${c.reset}`);
    lines.push("=".repeat(80));
    lines.push(
      `Thread: ${c.cyan}${summary.thread_id}${c.reset} · Status: ${summary.status === "OK" ? c.green : c.red}${summary.status}${c.reset} · Budget: ${summary.budget} tok (Used: ${summary.actual_tokens} tok)`,
    );
    lines.push(
      `Total Turns: ${summary.total_turns} · Pruned Intermediate Chatter: ${summary.pruned_turns} turns`,
    );
    lines.push("-".repeat(80));
    lines.push(`${c.bold}[1. ROOT INTENT]${c.reset}`);
    lines.push(`  ${summary.root_intent || "(None)"}`);
    lines.push("");
    lines.push(`${c.bold}[2. LATEST TURN OUTCOME]${c.reset} (Turn #${summary.latest_outcome.turn} · ${summary.latest_outcome.agent})`);
    lines.push(`  Status: ${summary.latest_outcome.status} · Tools: ${summary.latest_outcome.tools_count}`);
    lines.push(`  Response: ${summary.latest_outcome.response || "(No response)"}`);

    if (summary.failed_tools.length > 0) {
      lines.push("");
      lines.push(`${c.bold}${c.red}[3. FAILED TOOLS & ANOMALIES]${c.reset} (${summary.failed_tools.length} failure${summary.failed_tools.length > 1 ? "s" : ""})`);
      for (const ft of summary.failed_tools) {
        lines.push(`  - Turn #${ft.turn} [${ft.agent}] Tool '${ft.name}': ${ft.error}`);
        if (ft.input) {
          lines.push(`    Input: ${ft.input}`);
        }
      }
    } else {
      lines.push("");
      lines.push(`${c.dim}[3. FAILED TOOLS] None (all tools passed successfully)${c.reset}`);
    }

    lines.push("=".repeat(80));
    return lines.join("\n");
  }
}
