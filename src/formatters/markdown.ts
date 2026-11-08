/**
 * Markdown formatter for buzz-trace.
 * Generates formatted Markdown reports suitable for GitLab MRs, GitHub PRs, and incident docs.
 */

import { ThreadTelemetry } from "../models.js";
import { describePoster, edgeLabel, formatCost, handledLabel, ID_NOT_RECORDED, shortId, STEERING_NOT_RECORDED } from "./edge-label.js";

const POSTED_CHARS = 300;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > POSTED_CHARS ? `${flat.slice(0, POSTED_CHARS)}...` : flat;
}

export class MarkdownRenderer {
  render(t: ThreadTelemetry): string {
    const lines: string[] = [];
    let section = 0;
    const heading = (title: string) => {
      section += 1;
      lines.push(`## ${section}. ${title}`);
      lines.push("");
    };

    const threadLabel = t.threadId.length > 16 ? `${t.threadId.slice(0, 16)}...` : t.threadId;
    lines.push(`# Thread Execution Report: \`${threadLabel}\``);
    lines.push("");
    heading("Overview");
    lines.push("| Metric | Value |");
    lines.push("| :--- | :--- |");
    lines.push(`| **Thread Root ID** | \`${t.threadId}\` |`);
    lines.push(`| **Project** | \`${t.project ?? "(not found)"}\` |`);
    lines.push(`| **Session ID** | \`${t.sessionId || "N/A"}\` |`);
    if (t.source) {
      lines.push(`| **Source** | \`${t.source}\` |`);
    }
    lines.push(`| **Status** | \`${t.status}\` |`);
    lines.push(`| **Total Turns** | \`${t.totalTurns}\` |`);
    lines.push(
      `| **Total Tokens** | \`${t.totalTokens.toLocaleString()}\` (Prompt: \`${t.totalPromptTokens.toLocaleString()}\` · Completion: \`${t.totalCompletionTokens.toLocaleString()}\`) |`,
    );
    const cost = formatCost(t.totalCostUsd);
    if (cost) {
      lines.push(`| **Total Cost** | \`${cost}\` |`);
    }
    lines.push(`| **Total Latency** | \`${(t.totalDurationMs / 1000).toFixed(2)}s\` |`);
    lines.push("");

    if (t.anomalies.length > 0) {
      heading("Detected Anomalies");
      for (const a of t.anomalies) {
        const turnRef = a.turnIndex ? `Turn ${a.turnIndex}` : "Thread";
        lines.push(`- **[${a.severity}]** ${turnRef}: ${a.message}`);
      }
      lines.push("");
    }

    const possible = t.turns.filter((x) => (x.parentCandidates?.length ?? 0) > 0);
    if (t.dag && (t.dag.edges.length > 0 || possible.length > 0)) {
      heading("Multi-Agent DAG Hierarchy");
      lines.push("```mermaid");
      lines.push("graph TD");
      const label = (n: number) => {
        const turn = t.turns.find((x) => x.turnIndex === n);
        return turn ? `T${n}["Turn ${n}: ${turn.agentName}"]` : `T${n}`;
      };
      for (const edge of t.dag.edges) {
        const fromTurn = t.turns.find((x) => x.turnIndex === edge.fromTurnIndex);
        const toTurn = t.turns.find((x) => x.turnIndex === edge.toTurnIndex);
        const fromLabel = fromTurn
          ? `T${edge.fromTurnIndex}["Turn ${edge.fromTurnIndex}: ${fromTurn.agentName}"]`
          : `T${edge.fromTurnIndex}`;
        const toLabel = toTurn
          ? `T${edge.toTurnIndex}["Turn ${edge.toTurnIndex}: ${toTurn.agentName}"]`
          : `T${edge.toTurnIndex}`;
        // An exact link is a solid arrow; one that rests on inference is dashed and says so.
        const arrow =
          edge.type === "INFERRED"
            ? "-. inferred .->"
            : edge.type === "THREAD_ROOT"
              ? "-. thread root .->"
              : edge.type === "TEMPORAL"
                ? "-. by time .->"
                : "-->";
        lines.push(`  ${fromLabel} ${arrow} ${toLabel}`);
      }
      // A parent message no span names, which several turns could have posted: each is only a possible parent.
      for (const turn of possible) {
        for (const candidate of turn.parentCandidates ?? []) {
          lines.push(`  ${label(candidate)} -. possible parent .-> ${label(turn.turnIndex)}`);
        }
      }
      lines.push("```");
      lines.push("");
    }

    heading("Turn Timeline");
    lines.push("| Turn | Agent | Parent | Model | Status | Latency | Tokens | Cost | Tools | Trace ID |");
    lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |");

    for (const turn of t.turns) {
      const toolsSummary = turn.tools.length > 0 ? `${turn.tools.length} ops` : "none";
      const shortTrace = turn.traceId.length > 12 ? `${turn.traceId.slice(0, 12)}...` : turn.traceId;
      const how = edgeLabel(turn);
      const parent = turn.parentTurnIndex ? `${turn.parentTurnIndex}${how ? ` (${how})` : ""}` : "—";
      const turnCost = formatCost(turn.costUsd) ?? "—";
      lines.push(
        `| **${turn.turnIndex}** | \`${turn.agentName}\` | ${parent} | \`${turn.modelName}\` | \`${turn.statusCode}\` | ` +
          `\`${(turn.durationMs / 1000).toFixed(1)}s\` | \`${turn.totalTokens.toLocaleString()}\` | ${turnCost} | ${toolsSummary} | \`${shortTrace}\` |`,
      );
    }
    lines.push("");

    if (t.turns.length > 0) {
      heading("Message links");
      lines.push("| Turn | Agent | Handled | Started by | Replies to | Parent posted by | Posted |");
      lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | :--- |");
      for (const turn of t.turns) {
        const ids = (turn.posts ?? []).map((p) => (p.eventId ? `\`${shortId(p.eventId)}\`` : ID_NOT_RECORDED));
        const unplaced = (turn.postedEventIds ?? []).filter((id) => !(turn.posts ?? []).some((p) => p.eventId === id)).map((id) => `\`${shortId(id)}\``);
        const posted = [...ids, ...unplaced].join(", ") || ID_NOT_RECORDED;
        lines.push(
          `| **${turn.turnIndex}** | \`${turn.agentName}\` | ${handledLabel(turn).replace(/ messages?/, "")} | ` +
            `${turn.nostrEventId ? `\`${shortId(turn.nostrEventId)}\`` : "—"} | ` +
            `${turn.parentMessage ? `\`${shortId(turn.parentMessage.id)}\`` : "—"} | ${describePoster(turn)} | ${posted} |`,
        );
      }
      lines.push("");
      for (const turn of t.turns) {
        for (const message of turn.steered ?? []) {
          const id = message.eventId ? `\`${shortId(message.eventId)}\`` : "a message with no id recorded";
          const how = message.source === "reply_call" ? " (inferred from a reply call; text not recorded)" : "";
          lines.push(
            `- Turn ${turn.turnIndex} · ${turn.agentName} also handled ${id}${message.priority ? ` (${message.priority})` : ""}${message.text ? `: ${oneLine(message.text)}` : ""}${how}`,
          );
        }
      }
      if (!t.steeringRecorded) {
        lines.push("");
        lines.push(`> ${STEERING_NOT_RECORDED.charAt(0).toUpperCase()}${STEERING_NOT_RECORDED.slice(1)}: a message that arrived while a turn was running leaves no span here.`);
      }
      lines.push("");
    }

    if (t.turns.some((turn) => (turn.postedTexts?.length ?? 0) > 0)) {
      heading("What the agents posted");
      for (const turn of t.turns) {
        for (const text of turn.postedTexts ?? []) {
          lines.push(`- **Turn ${turn.turnIndex} · ${turn.agentName}:** ${oneLine(text)}`);
        }
      }
      lines.push("");
    }

    if (t.turns.some((turn) => turn.tools.length > 0)) {
      heading("Tool Execution Breakdown");
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
