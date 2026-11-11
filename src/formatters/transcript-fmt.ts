/**
 * Renderers of a transcript: for a terminal, for a Markdown report, and as JSON.
 *
 * Nothing is cut. A request and a response are shown as the runtime recorded them (a JSON value in its readable form, a text as
 * it is), and what the telemetry lacks is said in words: a response the runtime cut, a turn whose root span was never exported.
 */

import type { DialogueEntry } from "../engine/dialogue.js";
import type { Payload, ToolStep, Transcript, TranscriptStep, TranscriptTurn } from "../engine/transcript.js";
import { printable } from "./printable.js";
import { readableLines } from "./readable.js";

export interface StepsRenderOptions {
  verbose?: boolean;
}

/** Said under a turn whose trace holds no `agent_turn` span. */
export const NO_ROOT_NOTE =
  "no agent_turn span was exported for this trace (the process ended before it did): its agent, its end and its closing text are not known, and its times are those of the spans seen";

/** Said when the filters (`--turn`, `--last`, `--agent`) left no turn of a thread that has some. */
const NO_TURN_MATCHES = (total: number): string => `No turn matches the filters (the thread has ${total}).`;

const GUTTER = "│";
const RULE = "=".repeat(80);
const NUMBER = new Intl.NumberFormat("en-US");

/** `04:46:13.000Z`: the time of day in UTC, to the millisecond. */
const clock = (date: Date | null): string => (date ? `${date.toISOString().slice(11, 23)}Z` : "--:--:--.---Z");
const seconds = (ms: number | null): string => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
const indent = (lines: string[], by = 2): string[] => lines.map((line) => (line === "" ? "" : `${" ".repeat(by)}${line}`));
const textLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

/** A recorded payload as lines: JSON in its readable form, text as it is, and a word for nothing at all. */
function payloadLines(payload: Payload): string[] {
  if (payload.json !== undefined) {
    return readableLines(payload.json);
  }
  return payload.text === "" ? ["(empty)"] : textLines(payload.text);
}

/** `label:` and the payload under it; `label: (not recorded)` when the runtime recorded nothing. */
function labelled(label: string, payload: Payload | null): string[] {
  if (payload === null) {
    return [`${label}: (not recorded)`];
  }
  return payload.json === undefined && payload.text === "" ? [`${label}: (empty)`] : [`${label}:`, ...indent(payloadLines(payload))];
}

function truncationNote(step: ToolStep): string | null {
  if (!step.responseTruncated || step.responseBytes === null) {
    return null;
  }
  return `response cut by the runtime: recorded ${NUMBER.format(step.response?.bytes ?? 0)} of ${NUMBER.format(step.responseBytes)} bytes`;
}

const agentLabel = (turn: TranscriptTurn): string => turn.agent ?? "(agent not recorded)";

/** What became of something the agent said in a call, in words. */
function outcomeNote(line: DialogueEntry): string | null {
  switch (line.outcome) {
    case "complete":
      return "spoken in full";
    case "interrupted":
      return `cut off by ${line.interruptedBy ?? "someone"} after “${line.spoken ?? ""}”`;
    case "not_spoken":
      return "not spoken";
    case "async":
      return "sent without waiting for it to end";
    case "unknown":
      return line.result ? `result: ${line.result}` : null;
    default:
      return null;
  }
}

/** What a dialogue line says about itself besides who said it. `again`: the turn whose start was this same message. */
function lineNotes(line: DialogueEntry, again?: number): string[] {
  if (line.direction === "in" && line.channel === "meeting") {
    return [`call ${line.offset ?? "?"}`, ...(line.reason ? [line.reason] : [])];
  }
  if (line.direction === "in") {
    return [line.via === "steer" ? "steered message" : "message", ...(again === undefined ? [] : [`same message as turn ${again}`])];
  }
  if (line.channel === "meeting") {
    const outcome = outcomeNote(line);
    return ["said in the call", ...(outcome ? [outcome] : [])];
  }
  return ["posted to the thread", ...(line.eventId ? [`message ${line.eventId.slice(0, 8)}…`] : [])];
}

/** What a payload is in JSON output: the JSON value when it is one, else the text; null when nothing was recorded. */
const valueOf = (payload: Payload | null): unknown => (payload === null ? null : (payload.json ?? payload.text));
const isoOf = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** A fenced block that its own text cannot close: more backticks than the longest run inside it. */
function fence(lines: string[]): string[] {
  const longest = Math.max(0, ...[...lines.join("\n").matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return [`${ticks}text`, ...lines, ticks];
}

/** A block quote, blank lines kept as empty quoted lines. */
const quote = (lines: string[]): string[] => lines.map((line) => (line === "" ? ">" : `> ${line}`));

const threadLabel = (id: string): string => (id.length > 16 ? `${id.slice(0, 16)}...` : id);

/** For each dialogue line that is a message already seen under an earlier turn (a restart starts a turn again from the same message): that turn. */
function repeatedMessages(lines: DialogueEntry[]): Map<DialogueEntry, number> {
  const first = new Map<string, number>();
  const again = new Map<DialogueEntry, number>();
  for (const line of lines) {
    if (line.via !== "message" || !line.eventId) {
      continue;
    }
    const earlier = first.get(line.eventId);
    if (earlier === undefined) {
      first.set(line.eventId, line.turn);
    } else if (earlier !== line.turn) {
      again.set(line, earlier);
    }
  }
  return again;
}

export class TranscriptRenderer {
  readonly useColors: boolean;

  constructor(useColors = true) {
    this.useColors = useColors && !("NO_COLOR" in process.env);
  }

  private c(code: string, text: string): string {
    return this.useColors ? `\u001b[${code}m${text}\u001b[0m` : text;
  }
  private bold = (text: string): string => this.c("1", text);
  private dim = (text: string): string => this.c("2", text);
  private cyan = (text: string): string => this.c("36", text);
  private green = (text: string): string => this.c("32;1", text);
  private red = (text: string): string => this.c("31;1", text);
  private yellow = (text: string): string => this.c("33;1", text);

  private badge(t: Transcript): string {
    return t.status === "OK" ? this.green("[ OK ]") : this.red(`[ ${t.status} ]`);
  }

  /** The banner and the facts about the thread. */
  private banner(t: Transcript, title: string, summary: string): string[] {
    const lines = [this.bold(RULE), `${this.cyan(this.bold("BUZZ-TRACE"))} · ${title}   ${this.badge(t)}`, this.bold(RULE)];
    lines.push(`  ${this.bold("Thread ID   :")} ${this.cyan(t.threadId)}`);
    lines.push(`  ${this.bold("Project     :")} ${t.project ?? "(not found)"}`);
    if (t.sessionId && t.sessionId !== t.threadId) {
      lines.push(`  ${this.bold("Session ID  :")} ${t.sessionId}`);
    }
    if (t.channelId) {
      lines.push(`  ${this.bold("Channel ID  :")} ${t.channelId}`);
    }
    if (t.sessionUrl) {
      lines.push(`  ${this.bold("Phoenix UI  :")} ${this.cyan(t.sessionUrl)}`);
    }
    if (t.source) {
      lines.push(`  ${this.bold("Source      :")} ${t.source}`);
    }
    lines.push(`  ${this.bold("Turns       :")} ${t.turns.length} shown of ${t.totalTurns} · ${summary}`);
    if (t.startTime && t.endTime) {
      lines.push(`  ${this.bold("Window      :")} ${t.startTime.toISOString()} → ${t.endTime.toISOString()}`);
    }
    lines.push("");
    return lines;
  }

  private notFound(t: Transcript): string[] {
    if (t.totalTurns > 0) {
      return [this.dim(`  ${NO_TURN_MATCHES(t.totalTurns)}`), ""];
    }
    const lines = [this.dim("  (No agent turns recorded for this thread)")];
    if (t.tried.length > 0) {
      lines.push("", `  ${this.bold("Looked in:")}`, ...t.tried.map((place) => `    - ${place}`));
    }
    lines.push("");
    return lines;
  }

  terminal(transcript: Transcript, options: StepsRenderOptions = {}): string {
    const t = printable(transcript);
    const steps = t.turns.reduce((n, turn) => n + turn.steps.length, 0);
    const lines = this.banner(t, "Transcript", `${steps} steps`);
    if (t.turns.length === 0) {
      return [...lines, ...this.notFound(t)].join("\n");
    }
    for (const turn of t.turns) {
      lines.push(...this.turnBlock(turn, options));
    }
    return lines.join("\n");
  }

  private turnBlock(turn: TranscriptTurn, options: StepsRenderOptions): string[] {
    const g = this.dim(GUTTER);
    const status = turn.status === "OK" ? this.green("OK") : this.red(turn.status);
    const lines: string[] = [`  ${this.bold(`Turn ${turn.turnIndex}`)} · ${this.cyan(this.bold(agentLabel(turn)))} · ${this.c("35", turn.model)} [${status}]`];
    const row = (label: string, value: string) => lines.push(`  ${g} ${this.bold(label.padEnd(9))}: ${value}`);
    row("Trace", turn.traceId);
    if (turn.traceUrl) {
      row("Trace URL", this.cyan(turn.traceUrl));
    }
    row("Time", `${clock(turn.startTime)} → ${clock(turn.endTime)} · ${seconds(turn.durationMs)}`);
    if (!turn.rootRecorded) {
      row("Note", this.yellow(NO_ROOT_NOTE));
    }
    if (turn.request.from) {
      row("From", turn.request.from);
    }
    if (turn.eventId) {
      row("Event", turn.eventId);
    }
    const request = turn.request.message ?? turn.request.prompt?.text ?? null;
    if (request !== null) {
      lines.push(`  ${g} ${this.bold("Request".padEnd(9))}:`, ...indent(textLines(request)).map((line) => `  ${g} ${line}`));
    }
    if (options.verbose && turn.request.prompt && turn.request.message !== null) {
      lines.push(`  ${g} ${this.bold("Prompt".padEnd(9))}:`, ...indent(textLines(turn.request.prompt.text)).map((line) => `  ${g} ${line}`));
    }
    for (const step of turn.steps) {
      lines.push(`  ${g}`, ...this.stepLines(step).map((line) => `  ${g} ${line}`));
    }
    if (turn.output) {
      lines.push(`  ${g}`, `  ${g} ${this.bold("Output".padEnd(9))}:`, ...indent(payloadLines(turn.output)).map((line) => `  ${g} ${line}`));
    }
    lines.push(`  ${this.dim(`└${"─".repeat(76)}`)}`, "");
    return lines;
  }

  private stepLines(step: TranscriptStep): string[] {
    const head = `#${step.seq}  ${clock(step.at)}`;
    switch (step.type) {
      case "tool": {
        const ok = step.status === "OK" ? this.green("✓") : this.red("✗");
        const took = step.durationMs === null ? "" : `  ${Math.round(step.durationMs)}ms`;
        const asked = step.modelCall === null ? "" : `  ${this.dim(`(model call ${step.modelCall})`)}`;
        const lines = [`${head}  ${this.cyan(step.name)}  ${ok}${took}${asked}`];
        const body: string[] = [];
        if (step.error) {
          body.push(`error: ${step.error}`);
        }
        body.push(...labelled("request", step.request));
        const cut = truncationNote(step);
        body.push(...labelled("response", step.response));
        if (cut) {
          body.push(this.yellow(cut));
        }
        return [...lines, ...indent(body, 4)];
      }
      case "assistant":
        return [`${head}  ${this.cyan("assistant")}${step.modelCall === null ? "" : `  ${this.dim(`(model call ${step.modelCall})`)}`}`, ...indent(textLines(step.text), 4)];
      case "model": {
        const cache = step.cacheReadTokens > 0 ? ` (cache ${NUMBER.format(step.cacheReadTokens)})` : "";
        const asked = step.asked.length > 0 ? ` · asked: ${step.asked.join(", ")}` : "";
        const took = step.durationMs === null ? "" : ` · ${Math.round(step.durationMs)}ms`;
        return [
          `${head}  ${this.dim(`model call ${step.modelCall ?? "?"} · ${step.model ?? "model"} · ${step.promptTokens} → ${step.completionTokens} tokens${cache}${took}${asked}`)}`,
        ];
      }
      case "steer": {
        const late = step.delivered === false ? this.yellow("  (not delivered: the turn ended before it reached it)") : "";
        return [`${head}  ${this.cyan(`steer from ${step.sender ?? "unknown sender"}`)}${late}`, ...indent(step.text === null ? ["(text not recorded)"] : textLines(step.text), 4)];
      }
    }
  }

  /** The title and the table of facts that open a Markdown report. */
  private mdHead(t: Transcript, title: string, summary: string): string[] {
    const rows = [
      ["Thread ID", `\`${t.threadId}\``],
      ["Project", `\`${t.project ?? "(not found)"}\``],
      ...(t.sessionId && t.sessionId !== t.threadId ? [["Session ID", `\`${t.sessionId}\``]] : []),
      ...(t.channelId ? [["Channel ID", `\`${t.channelId}\``]] : []),
      ...(t.sessionUrl ? [["Phoenix UI", t.sessionUrl]] : []),
      ...(t.source ? [["Source", `\`${t.source}\``]] : []),
      ["Status", `\`${t.status}\``],
      ["Turns", `\`${t.turns.length} shown of ${t.totalTurns}\` · ${summary}`],
      ...(t.startTime && t.endTime ? [["Window", `\`${t.startTime.toISOString()} → ${t.endTime.toISOString()}\``]] : []),
    ];
    return [`# ${title}: \`${threadLabel(t.threadId)}\``, "", "| Metric | Value |", "| :--- | :--- |", ...rows.map(([k, v]) => `| **${k}** | ${v} |`), ""];
  }

  private mdNotFound(t: Transcript): string[] {
    if (t.totalTurns > 0) {
      return [`_${NO_TURN_MATCHES(t.totalTurns)}_`, ""];
    }
    return ["_No agent turns recorded for this thread._", "", ...(t.tried.length > 0 ? ["**Looked in:**", "", ...t.tried.map((place) => `- ${place}`), ""] : [])];
  }

  private mdTurnHead(turn: TranscriptTurn, extra = ""): string[] {
    const agent = turn.agent === null ? "(agent not recorded)" : `\`${turn.agent}\``;
    const lines = [`## Turn ${turn.turnIndex} — ${agent} · \`${turn.model}\` · ${turn.status}${extra}`, ""];
    lines.push(`- **Trace:** \`${turn.traceId}\`${turn.traceUrl ? ` ([open](${turn.traceUrl}))` : ""}`);
    lines.push(`- **Time:** \`${clock(turn.startTime)} → ${clock(turn.endTime)}\` · ${seconds(turn.durationMs)}`);
    if (turn.request.from) {
      lines.push(`- **From:** ${turn.request.from}`);
    }
    if (turn.eventId) {
      lines.push(`- **Event:** \`${turn.eventId}\``);
    }
    lines.push("");
    if (!turn.rootRecorded) {
      lines.push(...quote([NO_ROOT_NOTE]), "");
    }
    return lines;
  }

  /** `**Label**` and the payload in a fence; `_(not recorded)_` when the runtime recorded nothing. */
  private mdPayload(label: string, payload: Payload | null): string[] {
    if (payload === null) {
      return [`**${label}**`, "", "_(not recorded)_", ""];
    }
    return [`**${label}**`, "", ...fence(payload.json === undefined && payload.text === "" ? ["(empty)"] : payloadLines(payload)), ""];
  }

  markdown(transcript: Transcript, options: StepsRenderOptions = {}): string {
    const t = printable(transcript);
    const steps = t.turns.reduce((n, turn) => n + turn.steps.length, 0);
    const out = this.mdHead(t, "Thread Transcript", `${steps} steps`);
    if (t.turns.length === 0) {
      return [...out, ...this.mdNotFound(t)].join("\n");
    }
    for (const turn of t.turns) {
      out.push(...this.mdTurnHead(turn));
      const request = turn.request.message ?? turn.request.prompt?.text ?? null;
      if (request !== null) {
        out.push("**Request**", "", ...fence(textLines(request)), "");
      }
      if (options.verbose && turn.request.prompt && turn.request.message !== null) {
        out.push("**Prompt**", "", ...fence(textLines(turn.request.prompt.text)), "");
      }
      for (const step of turn.steps) {
        out.push(...this.mdStep(step));
      }
      if (turn.output) {
        out.push(...this.mdPayload("Output", turn.output));
      }
    }
    return out.join("\n");
  }

  private mdStep(step: TranscriptStep): string[] {
    const at = `\`${clock(step.at)}\``;
    switch (step.type) {
      case "tool": {
        const took = step.durationMs === null ? "" : ` · ${Math.round(step.durationMs)}ms`;
        const asked = step.modelCall === null ? "" : ` · model call ${step.modelCall}`;
        const lines = [`### #${step.seq} \`${step.name}\` ${step.status === "OK" ? "✓" : "✗"} · ${at}${took}${asked}`, ""];
        if (step.error) {
          lines.push(...quote([`error: ${step.error}`]), "");
        }
        lines.push(...this.mdPayload("Request", step.request), ...this.mdPayload("Response", step.response));
        const cut = truncationNote(step);
        if (cut) {
          lines.push(...quote([cut]), "");
        }
        return lines;
      }
      case "assistant":
        return [`### #${step.seq} assistant · ${at}${step.modelCall === null ? "" : ` · model call ${step.modelCall}`}`, "", ...fence(textLines(step.text)), ""];
      case "model": {
        const cache = step.cacheReadTokens > 0 ? ` (cache ${NUMBER.format(step.cacheReadTokens)})` : "";
        const asked = step.asked.length > 0 ? ` · asked: ${step.asked.join(", ")}` : "";
        return [`### #${step.seq} model call ${step.modelCall ?? "?"} · ${step.model ?? "model"} · ${step.promptTokens} → ${step.completionTokens} tokens${cache} · ${at}${asked}`, ""];
      }
      case "steer":
        return [
          `### #${step.seq} steer from ${step.sender ?? "unknown sender"} · ${at}`,
          "",
          ...(step.delivered === false ? [...quote(["not delivered: the turn ended before it reached it"]), ""] : []),
          ...fence(step.text === null ? ["(text not recorded)"] : textLines(step.text)),
          "",
        ];
    }
  }

  /** The fields every JSON form of a transcript starts with. */
  private jsonHead(t: Transcript, view: "steps" | "dialogue") {
    return {
      view,
      thread_id: t.threadId,
      project: t.project,
      session_id: t.sessionId,
      channel_id: t.channelId,
      source: t.source,
      session_url: t.sessionUrl,
      status: t.status,
      ...(t.status === "NOT_FOUND" && t.tried.length > 0 ? { tried: t.tried } : {}),
      total_turns: t.totalTurns,
      shown_turns: t.turns.length,
      start_time: isoOf(t.startTime),
      end_time: isoOf(t.endTime),
    };
  }

  private stepJson(step: TranscriptStep) {
    const base = { seq: step.seq, type: step.type, start_time: isoOf(step.at) };
    switch (step.type) {
      case "tool":
        return {
          ...base,
          name: step.name,
          span_id: step.spanId,
          call_id: step.callId,
          model_call: step.modelCall,
          end_time: isoOf(step.end),
          duration_ms: step.durationMs,
          status: step.status,
          error: step.error,
          request: valueOf(step.request),
          response: valueOf(step.response),
          response_truncated: step.responseTruncated,
          response_recorded_bytes: step.response?.bytes ?? 0,
          response_returned_bytes: step.responseBytes,
          posted: step.posted ? { event_id: step.posted.eventId, reply_to: step.posted.replyTo } : null,
        };
      case "assistant":
        return { ...base, model_call: step.modelCall, model: step.model, text: step.text };
      case "model":
        return {
          ...base,
          model_call: step.modelCall,
          model: step.model,
          duration_ms: step.durationMs,
          prompt_tokens: step.promptTokens,
          completion_tokens: step.completionTokens,
          cache_read_tokens: step.cacheReadTokens,
          asked: step.asked,
        };
      case "steer":
        return { ...base, event_id: step.eventId, sender: step.sender, priority: step.priority, delivered: step.delivered, text: step.text };
    }
  }

  json(t: Transcript, indent = 2): string {
    return JSON.stringify(
      {
        ...this.jsonHead(t, "steps"),
        turns: t.turns.map((turn) => ({
          turn_index: turn.turnIndex,
          trace_id: turn.traceId,
          trace_url: turn.traceUrl,
          agent: turn.agent,
          model: turn.model,
          status: turn.status,
          status_message: turn.statusMessage,
          root_span: turn.rootRecorded,
          start_time: isoOf(turn.startTime),
          end_time: isoOf(turn.endTime),
          duration_ms: turn.durationMs,
          event_id: turn.eventId,
          reply_to: turn.replyTo,
          request: { from: turn.request.from, message: turn.request.message, prompt: turn.request.prompt?.text ?? null },
          output: valueOf(turn.output),
          steps: turn.steps.map((step) => this.stepJson(step)),
        })),
      },
      null,
      indent,
    );
  }

  dialogueTerminal(transcript: Transcript, entries: DialogueEntry[]): string {
    const t = printable(transcript);
    const lines = printable(entries);
    const again = repeatedMessages(lines);
    const incoming = lines.filter((line) => line.direction === "in").length;
    const out = this.banner(t, "Dialogue", `${lines.length} lines (${incoming} in · ${lines.length - incoming} out)`);
    if (t.turns.length === 0) {
      return [...out, ...this.notFound(t)].join("\n");
    }
    for (const turn of t.turns) {
      out.push(`  ${this.bold(`Turn ${turn.turnIndex}`)} · ${this.cyan(this.bold(agentLabel(turn)))} · ${clock(turn.startTime)} → ${clock(turn.endTime)}`);
      if (!turn.rootRecorded) {
        out.push(`  ${this.yellow(NO_ROOT_NOTE)}`);
      }
      for (const line of lines.filter((l) => l.turn === turn.turnIndex)) {
        const who = line.direction === "in" ? this.cyan(this.bold(line.speaker)) : this.green(this.bold(line.speaker));
        out.push(`  ${clock(line.at)}  ${who}  ${this.dim(`· ${lineNotes(line, again.get(line)).join(" · ")}`)}`, ...indent(textLines(line.text), 6));
      }
      out.push("");
    }
    return out.join("\n");
  }

  dialogueMarkdown(transcript: Transcript, entries: DialogueEntry[]): string {
    const t = printable(transcript);
    const lines = printable(entries);
    const again = repeatedMessages(lines);
    const incoming = lines.filter((line) => line.direction === "in").length;
    const out = this.mdHead(t, "Thread Dialogue", `${lines.length} lines (${incoming} in · ${lines.length - incoming} out)`);
    if (t.turns.length === 0) {
      return [...out, ...this.mdNotFound(t)].join("\n");
    }
    for (const turn of t.turns) {
      out.push(...this.mdTurnHead(turn));
      for (const line of lines.filter((l) => l.turn === turn.turnIndex)) {
        out.push(`**${line.speaker}** · \`${clock(line.at)}\` · ${lineNotes(line, again.get(line)).join(" · ")}`, "", ...quote(textLines(line.text)), "");
      }
    }
    return out.join("\n");
  }

  dialogueJson(t: Transcript, lines: DialogueEntry[], indent = 2): string {
    const incoming = lines.filter((line) => line.direction === "in").length;
    return JSON.stringify(
      {
        ...this.jsonHead(t, "dialogue"),
        counts: { in: incoming, out: lines.length - incoming },
        lines: lines.map((line) => ({
          turn: line.turn,
          time: isoOf(line.at),
          direction: line.direction,
          channel: line.channel,
          via: line.via,
          speaker: line.speaker,
          text: line.text,
          offset: line.offset,
          reason: line.reason,
          event_id: line.eventId,
          outcome: line.outcome,
          interrupted_by: line.interruptedBy,
          spoken: line.spoken,
          result: line.result,
        })),
      },
      null,
      indent,
    );
  }
}
