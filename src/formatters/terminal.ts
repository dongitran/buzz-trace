/**
 * Terminal UI formatter for buzz-trace.
 * Supports ANSI colors, tree diagrams, and clean box styling.
 */

import { ThreadTelemetry } from "../models.js";
import { edgeLabel, formatCost } from "./edge-label.js";

export class TerminalRenderer {
  readonly useColors: boolean;

  constructor(useColors = true) {
    this.useColors = useColors && !("NO_COLOR" in process.env);
  }

  private c(code: string, text: string): string {
    if (!this.useColors) {
      return text;
    }
    return `\x1b[${code}m${text}\x1b[0m`;
  }

  green(text: string): string {
    return this.c("32;1", text);
  }

  red(text: string): string {
    return this.c("31;1", text);
  }

  yellow(text: string): string {
    return this.c("33;1", text);
  }

  cyan(text: string): string {
    return this.c("36", text);
  }

  magenta(text: string): string {
    return this.c("35", text);
  }

  bold(text: string): string {
    return this.c("1", text);
  }

  dim(text: string): string {
    return this.c("2", text);
  }

  render(t: ThreadTelemetry, verbose = false): string {
    const lines: string[] = [];

    // 1. Header Banner
    const statusBadge = t.status === "OK" ? this.green("[ OK ]") : this.red(`[ ${t.status} ]`);
    lines.push(this.bold("=".repeat(80)));
    lines.push(`${this.cyan(this.bold("BUZZ-TRACE"))} · Multi-Agent Thread Execution Summary   ${statusBadge}`);
    lines.push(this.bold("=".repeat(80)));

    // Metadata
    lines.push(`  ${this.bold("Thread ID   :")} ${this.cyan(t.threadId)}`);
    lines.push(`  ${this.bold("Project     :")} ${t.project}`);
    if (t.sessionId && t.sessionId !== t.threadId) {
      lines.push(`  ${this.bold("Session ID  :")} ${t.sessionId}`);
    }
    if (t.nostrThreadId && t.nostrThreadId !== t.threadId) {
      lines.push(`  ${this.bold("Nostr Root  :")} ${t.nostrThreadId}`);
    }
    if (t.nostrChannelId) {
      lines.push(`  ${this.bold("Channel ID  :")} ${t.nostrChannelId}`);
    }
    if (t.phoenixSessionUrl) {
      lines.push(`  ${this.bold("Phoenix UI  :")} ${this.cyan(t.phoenixSessionUrl)}`);
    }
    if (t.source) {
      lines.push(`  ${this.bold("Source      :")} ${t.source}`);
    }
    lines.push(
      `  ${this.bold("Total Tokens:")} ${this.yellow(t.totalTokens.toLocaleString())} ` +
        `(Prompt: ${t.totalPromptTokens.toLocaleString()} · Completion: ${t.totalCompletionTokens.toLocaleString()})`,
    );
    const cost = formatCost(t.totalCostUsd);
    if (cost) {
      lines.push(`  ${this.bold("Total Cost  :")} ${this.yellow(cost)}`);
    }
    const cacheRead = t.turns.reduce((acc, turn) => acc + (turn.cacheReadTokens ?? 0), 0);
    const cacheWrite = t.turns.reduce((acc, turn) => acc + (turn.cacheWriteTokens ?? 0), 0);
    if (cacheRead > 0 || cacheWrite > 0) {
      lines.push(
        `  ${this.bold("Cache       :")} ${cacheRead.toLocaleString()} read · ${cacheWrite.toLocaleString()} written`,
      );
    }
    lines.push(
      `  ${this.bold("Total Turns :")} ${t.turns.length} turns · ` +
        `${this.bold("Duration:")} ${(t.totalDurationMs / 1000).toFixed(2)}s`,
    );
    lines.push("");

    // 2. Anomalies Banner (if any)
    if (t.anomalies.length > 0) {
      lines.push(this.bold("-".repeat(80)));
      lines.push(`  ${this.red(this.bold("ANOMALIES & DIAGNOSTICS DETECTED:"))}`);
      for (const a of t.anomalies) {
        const sevBadge =
          a.severity === "CRITICAL"
            ? this.red("[CRITICAL]")
            : a.severity === "WARNING"
              ? this.yellow("[WARNING]")
              : this.dim("[INFO]");
        const turnRef = a.turnIndex ? `(Turn ${a.turnIndex})` : "(Thread-level)";
        lines.push(`    ${sevBadge} ${turnRef}: ${a.message}`);
      }
      lines.push(this.bold("-".repeat(80)));
      lines.push("");
    }

    // 3. Turns Timeline
    lines.push(this.bold("CHRONOLOGICAL EXECUTION TIMELINE:"));
    lines.push("");

    if (t.turns.length === 0) {
      lines.push(this.dim("  (No agent turns recorded for this thread)"));
      if (t.sourcesTried.length > 0) {
        lines.push("");
        lines.push(`  ${this.bold("Looked in:")}`);
        for (const place of t.sourcesTried) {
          lines.push(`    - ${place}`);
        }
      }
      lines.push("");
      return lines.join("\n");
    }

    for (const turn of t.turns) {
      const turnBadge = turn.statusCode === "OK" ? this.green("OK") : this.red(turn.statusCode);
      const durStr = `${(turn.durationMs / 1000).toFixed(1)}s`;
      const tokStr = `${turn.totalTokens.toLocaleString()} tok`;

      lines.push(
        `  ${this.bold(`Turn ${turn.turnIndex}`)} · ` +
          `${this.cyan(this.bold(turn.agentName))} ` +
          `[${turnBadge}] ` +
          `${this.dim(`(${durStr} · ${tokStr})`)}`,
      );
      lines.push(`  ${this.dim("│")}  ${this.bold("Trace ID :")} ${turn.traceId}`);
      if (turn.traceUrl) {
        lines.push(`  ${this.dim("│")}  ${this.bold("Trace URL:")} ${this.cyan(turn.traceUrl)}`);
      }
      if (turn.nostrEventId) {
        lines.push(`  ${this.dim("│")}  ${this.bold("Event ID :")} ${turn.nostrEventId}`);
      }
      if (turn.steeredEventIds && turn.steeredEventIds.length > 0) {
        const extra = turn.steeredEventIds.length;
        lines.push(
          `  ${this.dim("│")}  ${this.bold("Handled  :")} ${extra + 1} messages (${extra} arrived while the turn was running)`,
        );
      }
      if (turn.senderName) {
        lines.push(`  ${this.dim("│")}  ${this.bold("From     :")} ${turn.senderName}`);
      }
      if (turn.parentTurnIndex) {
        const branchTag = turn.branchId && turn.branchId !== "main" ? ` [${turn.branchId}]` : "";
        const how = edgeLabel(turn);
        lines.push(
          `  ${this.dim("│")}  ${this.bold("Reply To :")} Turn ${turn.parentTurnIndex}${how ? ` (${how})` : ""}${branchTag}`,
        );
      }
      lines.push(`  ${this.dim("│")}  ${this.bold("Model    :")} ${this.magenta(turn.modelName)}`);
      if (turn.contextPerCall && turn.modelCalls) {
        lines.push(
          `  ${this.dim("│")}  ${this.bold("Context  :")} ~${turn.contextPerCall.toLocaleString()} per call × ~${turn.modelCalls} calls`,
        );
      }

      if (turn.promptPreview) {
        lines.push(`  ${this.dim("│")}  ${this.bold("Prompt   :")} "${turn.promptPreview}"`);
      }

      // Tools
      if (turn.tools.length > 0) {
        lines.push(`  ${this.dim("│")}  ${this.bold("Tools    :")} ${turn.tools.length} operations`);
        for (const tool of turn.tools) {
          const toolStatus = tool.statusCode === "OK" ? this.green("✓") : this.red("✗");
          const toolDur = `${tool.durationMs.toFixed(0)}ms`;
          const summary = tool.inputSummary ? ` - ${tool.inputSummary}` : "";
          lines.push(
            `  ${this.dim("│")}    ${toolStatus} ${this.cyan(tool.name)} ` +
              `${this.dim(`(${toolDur})`)}${this.dim(summary)}`,
          );
          if (tool.error) {
            lines.push(`  ${this.dim("│")}      ${this.red("Error:")} ${tool.error}`);
          }
        }
      } else {
        lines.push(`  ${this.dim("│")}  ${this.bold("Tools    :")} ${this.dim("(none)")}`);
      }

      if (turn.postedTexts && turn.postedTexts.length > 0) {
        lines.push(`  ${this.dim("│")}  ${this.bold("Posted   :")} "${turn.responsePreview}"`);
      } else if (turn.responsePreview && verbose) {
        lines.push(`  ${this.dim("│")}  ${this.bold("Output   :")} "${turn.responsePreview}"`);
      }

      lines.push(`  ${this.dim("└" + "─".repeat(76))}`);
      lines.push("");
    }

    return lines.join("\n");
  }
}
