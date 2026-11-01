/**
 * Markdown formatter for buzz-trace.
 * Generates formatted Markdown reports suitable for GitLab MRs, GitHub PRs, and incident docs.
 */

import { ThreadTelemetry } from "../models.js";

export class MarkdownRenderer {
  render(t: ThreadTelemetry): string {
    const lines: string[] = [];

    const shortId = t.threadId.length > 16 ? `${t.threadId.slice(0, 16)}...` : t.threadId;
    lines.push(`# Thread Execution Report: \`${shortId}\``);
    lines.push("");
    lines.push("## 1. Overview");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("| :--- | :--- |");
    lines.push(`| **Thread Root ID** | \`${t.threadId}\` |`);
    lines.push(`| **Project** | \`${t.project}\` |`);
    lines.push(`| **Session ID** | \`${t.sessionId || "N/A"}\` |`);
    lines.push(`| **Status** | \`${t.status}\` |`);
    lines.push(`| **Total Turns** | \`${t.totalTurns}\` |`);
    lines.push(
      `| **Total Tokens** | \`${t.totalTokens.toLocaleString()}\` (Prompt: \`${t.totalPromptTokens.toLocaleString()}\` · Completion: \`${t.totalCompletionTokens.toLocaleString()}\`) |`,
    );
    lines.push(`| **Total Latency** | \`${(t.totalDurationMs / 1000).toFixed(2)}s\` |`);
    lines.push("");

    if (t.anomalies.length > 0) {
      lines.push("## 2. Detected Anomalies");
      lines.push("");
      for (const a of t.anomalies) {
        const turnRef = a.turnIndex ? `Turn ${a.turnIndex}` : "Thread";
        lines.push(`- **[${a.severity}]** ${turnRef}: ${a.message}`);
      }
      lines.push("");
    }

    if (t.dag && t.dag.edges.length > 0) {
      lines.push("## 3. Multi-Agent DAG Hierarchy");
      lines.push("");
      lines.push("```mermaid");
      lines.push("graph TD");
      for (const edge of t.dag.edges) {
        const fromTurn = t.turns.find((x) => x.turnIndex === edge.fromTurnIndex);
        const toTurn = t.turns.find((x) => x.turnIndex === edge.toTurnIndex);
        const fromLabel = fromTurn
          ? `T${edge.fromTurnIndex}["Turn ${edge.fromTurnIndex}: ${fromTurn.agentName}"]`
          : `T${edge.fromTurnIndex}`;
        const toLabel = toTurn
          ? `T${edge.toTurnIndex}["Turn ${edge.toTurnIndex}: ${toTurn.agentName}"]`
          : `T${edge.toTurnIndex}`;
        lines.push(`  ${fromLabel} --> ${toLabel}`);
      }
      lines.push("```");
      lines.push("");
    }

    const timelineHeading = t.dag && t.dag.edges.length > 0 ? "## 4. Turn Timeline" : "## 3. Turn Timeline";
    lines.push(timelineHeading);
    lines.push("");
    lines.push("| Turn | Agent | Model | Status | Latency | Tokens | Tools | Trace ID |");
    lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |");

    for (const turn of t.turns) {
      const toolsSummary = turn.tools.length > 0 ? `${turn.tools.length} ops` : "none";
      const shortTrace = turn.traceId.length > 12 ? `${turn.traceId.slice(0, 12)}...` : turn.traceId;
      lines.push(
        `| **${turn.turnIndex}** | \`${turn.agentName}\` | \`${turn.modelName}\` | \`${turn.statusCode}\` | ` +
          `\`${(turn.durationMs / 1000).toFixed(1)}s\` | \`${turn.totalTokens.toLocaleString()}\` | ${toolsSummary} | \`${shortTrace}\` |`,
      );
    }
    lines.push("");

    if (t.turns.some((turn) => turn.tools.length > 0)) {
      const toolHeading = t.dag && t.dag.edges.length > 0 ? "## 5. Tool Execution Breakdown" : "## 4. Tool Execution Breakdown";
      lines.push(toolHeading);
      lines.push("");
      for (const turn of t.turns) {
        if (turn.tools.length > 0) {
          lines.push(`### Turn ${turn.turnIndex} (${turn.agentName})`);
          for (const tool of turn.tools) {
            const statusMark = tool.statusCode === "OK" ? "✓" : "✗";
            lines.push(`- **${statusMark} \`${tool.name}\`** (${tool.durationMs.toFixed(0)}ms): \`${tool.inputSummary}\``);
            if (tool.error) {
              lines.push(`  - *Error:* \`${tool.error}\``);
            }
          }
          lines.push("");
        }
      }
    }

    return lines.join("\n");
  }
}
