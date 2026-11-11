/**
 * Transcript: what was asked and what came back in a thread, whole and in the order it happened.
 *
 * The other commands keep 80 characters of a tool's input and never read its output. Phoenix holds both: a tool span carries the
 * whole input (`input.value`) and the whole output (`output.value`) its runtime recorded, and `ThreadTelemetry` keeps every span
 * of every turn. The transcript is a projection of those spans, with nothing cut.
 *
 * What it does not do is invent. Where the telemetry itself holds less than happened, it says so: a response the runtime cut
 * (fewer bytes recorded than `tool.output_bytes`), a turn whose `agent_turn` span was never exported (no agent, no end).
 */

import { STEER_SPAN_NAME } from "../contract.js";
import type { AgentTurn, SpanNode, SteeredMessage, ThreadTelemetry } from "../models.js";
import { agentNameOf, findRootSpan, isToolCall, toolNameOf } from "./aggregator.js";
import { parseBuzzEnvelope } from "./envelope.js";

/** What a runtime recorded as the input or the output of a span: the text as it is, and the JSON read out of it when it is one. */
export interface Payload {
  text: string;
  json?: unknown;
  /** UTF-8 size of `text`. */
  bytes: number;
}

interface StepBase {
  /** Position in the turn, from 1. A filter drops steps but never renumbers the others. */
  seq: number;
  at: Date | null;
}

export interface ToolStep extends StepBase {
  type: "tool";
  name: string;
  spanId: string;
  callId: string | null;
  /** The model call (`llm.iteration`) that asked for this tool, when the trace shows which. */
  modelCall: number | null;
  end: Date | null;
  durationMs: number | null;
  status: "OK" | "ERROR";
  error: string | null;
  request: Payload | null;
  response: Payload | null;
  /** The runtime recorded fewer bytes of the response than the tool returned (`tool.output_bytes`). */
  responseTruncated: boolean;
  /** What the tool returned, in bytes, when the runtime cut the response; null otherwise. */
  responseBytes: number | null;
  /** A call that posted to the thread: the message it answered and, when recorded, the one it created. */
  posted: { eventId: string | null; replyTo: string | null } | null;
}

/** Words the model wrote (as against model calls that only asked for tools). */
export interface AssistantStep extends StepBase {
  type: "assistant";
  modelCall: number | null;
  model: string | null;
  text: string;
}

/** One model call, with its size and the tools it asked for (only with `verbose`). */
export interface ModelStep extends StepBase {
  type: "model";
  modelCall: number | null;
  model: string | null;
  durationMs: number | null;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  asked: string[];
}

/** A message that arrived while the turn ran and was injected into it. */
export interface SteerStep extends StepBase {
  type: "steer";
  eventId: string | null;
  sender: string | null;
  priority: string | null;
  delivered: boolean | null;
  text: string | null;
}

export type TranscriptStep = ToolStep | AssistantStep | ModelStep | SteerStep;

export interface TranscriptTurn {
  turnIndex: number;
  traceId: string;
  traceUrl: string | null;
  /** Null when the trace does not say (no `agent_turn` span was exported). */
  agent: string | null;
  model: string;
  status: string;
  statusMessage: string | null;
  /** False: the trace holds no root span (the process died before it ended). Its times then are those of the spans seen. */
  rootRecorded: boolean;
  startTime: Date | null;
  endTime: Date | null;
  durationMs: number | null;
  eventId: string | null;
  replyTo: string | null;
  request: { from: string | null; message: string | null; prompt: Payload | null };
  steps: TranscriptStep[];
  /** The closing text of the turn (`output.value` of its root span). */
  output: Payload | null;
}

export interface Transcript {
  threadId: string;
  project: string | null;
  sessionId: string | null;
  channelId: string | null;
  source: string | null;
  sessionUrl: string | null;
  status: string;
  tried: string[];
  /** Turns in the thread, before any filter. */
  totalTurns: number;
  startTime: Date | null;
  endTime: Date | null;
  turns: TranscriptTurn[];
}

export interface TranscriptOptions {
  /** Add a step per model call. */
  verbose?: boolean;
  /** Keep tool steps whose name contains one of these (case-insensitive); other kinds of step are dropped. */
  tools?: string[];
  /** Keep failed steps only. */
  failuresOnly?: boolean;
}

/** The most tool calls one model call is read to have asked for. */
const MAX_ASKS = 64;

/** A finite number from a span attribute, else null. */
function finite(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A recorded input or output as a payload. The text is kept as it is; when it is a JSON object or array it is read as well. Null
 * when the runtime recorded nothing; an empty text is a payload (the tool did return nothing).
 */
export function decodePayload(raw: unknown): Payload | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  const payload: Payload = { text, bytes: Buffer.byteLength(text, "utf8") };
  const head = text.trimStart()[0];
  if (head === "{" || head === "[") {
    try {
      // text that starts with { or [ and parses is an object or a list
      payload.json = JSON.parse(text) as unknown;
    } catch {
      // cut off, or not JSON after all: it stays text
    }
  }
  return payload;
}

const isLlmCall = (span: SpanNode): boolean => span.name.startsWith("llm:") || span.spanKind === "LLM";

/** The model call (`llm.iteration`, else its position among the turn's model calls) that asked for each tool call id. */
function modelCallsByToolCall(spans: SpanNode[]): Map<string, number> {
  const byCall = new Map<string, number>();
  let ordinal = 0;
  for (const span of spans) {
    if (!isLlmCall(span)) {
      continue;
    }
    ordinal += 1;
    const iteration = finite(span.attributes["llm.iteration"]) ?? ordinal;
    for (const call of toolCallsAskedBy(span)) {
      byCall.set(call.id, iteration);
    }
  }
  return byCall;
}

/** The tool calls a model call asked for (`llm.output_messages.0.message.tool_calls.N`), in order. */
function toolCallsAskedBy(span: SpanNode): Array<{ id: string; name: string | null }> {
  const asked: Array<{ id: string; name: string | null }> = [];
  for (let i = 0; i < MAX_ASKS; i++) {
    const prefix = `llm.output_messages.0.message.tool_calls.${i}.tool_call`;
    const id = span.attributes[`${prefix}.id`];
    if (typeof id !== "string") {
      break;
    }
    const name = span.attributes[`${prefix}.function.name`];
    asked.push({ id, name: typeof name === "string" ? name : null });
  }
  return asked;
}

const startOf = (span: SpanNode): number => (span.startTime ? span.startTime.getTime() : Number.POSITIVE_INFINITY);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Steps that start at the same instant: the model's words, then a steered message, then the tool. */
const RANK = { model: 0, assistant: 0, steer: 1, tool: 2 } as const;

interface Entry {
  step: TranscriptStep;
  time: number;
  order: number;
}

export class TranscriptBuilder {
  build(telemetry: ThreadTelemetry, options: TranscriptOptions = {}): Transcript {
    return {
      threadId: telemetry.threadId,
      project: telemetry.project,
      sessionId: telemetry.sessionId,
      channelId: telemetry.nostrChannelId ?? null,
      source: telemetry.source,
      sessionUrl: telemetry.phoenixSessionUrl ?? null,
      status: telemetry.status,
      tried: telemetry.sourcesTried,
      totalTurns: telemetry.totalTurns,
      startTime: telemetry.startTime ?? null,
      endTime: telemetry.endTime ?? null,
      turns: telemetry.turns.map((turn) => this.buildTurn(turn, options)),
    };
  }

  private buildTurn(turn: AgentTurn, options: TranscriptOptions): TranscriptTurn {
    const spans = [...turn.spans].sort((a, b) => startOf(a) - startOf(b));
    const root = findRootSpan(spans);
    const header = this.header(turn, spans, root);
    return { ...header, steps: this.steps(turn, spans, root, header.output, options) };
  }

  /** Everything about a turn but its steps. */
  private header(turn: AgentTurn, spans: SpanNode[], root: SpanNode | undefined): Omit<TranscriptTurn, "steps"> {
    // Like the other commands, a trace without a root span is read through its first span; unlike them, it is not given a name.
    const first = root ?? spans[0];
    const promptSpan = nonEmpty(root?.attributes["input.value"])
      ? root
      : spans.find((span) => !isToolCall(span) && span.name !== STEER_SPAN_NAME && nonEmpty(span.attributes["input.value"]));
    const prompt = decodePayload(promptSpan?.attributes["input.value"]);
    const closing = decodePayload(root?.attributes["output.value"]);

    let startTime = turn.startTime ?? null;
    let endTime = turn.endTime ?? null;
    let durationMs: number | null = root?.startTime && root.endTime ? turn.durationMs : null;
    if (!root) {
      // no span says when the turn began or ended: the window is that of the spans that were exported
      const starts = spans.map((s) => s.startTime?.getTime()).filter((t): t is number => t !== undefined);
      const ends = spans.map((s) => (s.endTime ?? s.startTime)?.getTime()).filter((t): t is number => t !== undefined);
      startTime = starts.length > 0 ? new Date(Math.min(...starts)) : null;
      endTime = ends.length > 0 ? new Date(Math.max(...ends)) : null;
      durationMs = startTime && endTime ? endTime.getTime() - startTime.getTime() : null;
    }

    return {
      turnIndex: turn.turnIndex,
      traceId: turn.traceId,
      traceUrl: turn.traceUrl ?? null,
      agent: first ? agentNameOf(first.attributes) : null,
      model: turn.modelName,
      status: turn.statusCode,
      statusMessage: turn.statusMessage ?? null,
      rootRecorded: root !== undefined,
      startTime,
      endTime,
      durationMs,
      eventId: turn.nostrEventId ?? null,
      replyTo: turn.nostrReplyTo ?? null,
      request: { from: turn.senderName ?? null, message: parseBuzzEnvelope(prompt?.text)?.content ?? null, prompt },
      output: closing && closing.text.trim() !== "" ? closing : null,
    };
  }

  private steps(turn: AgentTurn, spans: SpanNode[], root: SpanNode | undefined, output: Payload | null, options: TranscriptOptions): TranscriptStep[] {
    const asked = modelCallsByToolCall(spans);
    const posts = new Map((turn.posts ?? []).map((post) => [post.spanId, post]));
    const entries: Entry[] = [];
    const add = (step: TranscriptStep, time: number) => entries.push({ step, time, order: entries.length });

    let ordinal = 0;
    for (const span of spans) {
      if (span === root) {
        continue;
      }
      if (isToolCall(span)) {
        add(this.toolStep(span, asked, posts), startOf(span));
      } else if (isLlmCall(span)) {
        ordinal += 1;
        const modelCall = finite(span.attributes["llm.iteration"]) ?? ordinal;
        if (options.verbose) {
          add(this.modelStep(span, modelCall), startOf(span));
        }
        const words = span.attributes["llm.output_messages.0.message.content"];
        if (nonEmpty(words) && words.trim() !== output?.text.trim()) {
          add(this.assistantStep(span, modelCall, words), startOf(span));
        }
      }
    }
    for (const message of turn.steered ?? []) {
      if (message.source !== "reply_call") {
        const step = this.steerStep(message);
        add(step, step.at ? step.at.getTime() : Number.POSITIVE_INFINITY);
      }
    }

    entries.sort((a, b) => a.time - b.time || RANK[a.step.type] - RANK[b.step.type] || a.order - b.order);
    entries.forEach((entry, i) => {
      entry.step.seq = i + 1;
    });
    return entries.map((entry) => entry.step).filter((step) => this.keeps(step, options));
  }

  private keeps(step: TranscriptStep, options: TranscriptOptions): boolean {
    const wanted = (options.tools ?? []).map((name) => name.toLowerCase()).filter((name) => name !== "");
    if (wanted.length > 0 && (step.type !== "tool" || !wanted.some((name) => step.name.toLowerCase().includes(name)))) {
      return false;
    }
    if (options.failuresOnly && (step.type !== "tool" || step.status !== "ERROR")) {
      return false;
    }
    return true;
  }

  private toolStep(span: SpanNode, asked: Map<string, number>, posts: Map<string, NonNullable<AgentTurn["posts"]>[number]>): ToolStep {
    const attrs = span.attributes;
    const response = decodePayload(attrs["output.value"] ?? attrs["tool.output"]);
    const declared = finite(attrs["tool.output_bytes"]);
    const truncated = declared !== null && declared > (response?.bytes ?? 0);
    const callId = typeof attrs["tool.call_id"] === "string" ? attrs["tool.call_id"] : null;
    const failed = span.statusCode === "ERROR" || attrs["tool.is_error"] === true || attrs["tool.is_error"] === "true";
    const post = posts.get(span.spanId);
    return {
      seq: 0,
      type: "tool",
      at: span.startTime ?? null,
      name: toolNameOf(span),
      spanId: span.spanId,
      callId,
      modelCall: callId ? (asked.get(callId) ?? null) : null,
      end: span.endTime ?? null,
      durationMs: span.startTime && span.endTime ? span.durationMs : null,
      status: failed ? "ERROR" : "OK",
      error: span.statusCode === "ERROR" ? (span.statusMessage ?? null) : null,
      request: decodePayload(attrs["input.value"]),
      response,
      responseTruncated: truncated,
      responseBytes: truncated ? declared : null,
      posted: post ? { eventId: post.eventId, replyTo: post.replyTo } : null,
    };
  }

  private assistantStep(span: SpanNode, modelCall: number, text: string): AssistantStep {
    const model = span.attributes["llm.model_name"];
    return { seq: 0, type: "assistant", at: span.startTime ?? null, modelCall, model: typeof model === "string" ? model : null, text };
  }

  private modelStep(span: SpanNode, modelCall: number): ModelStep {
    const attrs = span.attributes;
    const model = attrs["llm.model_name"];
    return {
      seq: 0,
      type: "model",
      at: span.startTime ?? null,
      modelCall,
      model: typeof model === "string" ? model : null,
      durationMs: span.startTime && span.endTime ? span.durationMs : null,
      promptTokens: finite(attrs["llm.token_count.prompt"]) ?? 0,
      completionTokens: finite(attrs["llm.token_count.completion"]) ?? 0,
      cacheReadTokens: finite(attrs["llm.token_count.prompt_details.cache_read"]) ?? 0,
      asked: toolCallsAskedBy(span).map((call) => call.name ?? call.id),
    };
  }

  private steerStep(message: SteeredMessage): SteerStep {
    return {
      seq: 0,
      type: "steer",
      at: message.at === null ? null : new Date(message.at),
      eventId: message.eventId,
      sender: message.sender,
      priority: message.priority,
      delivered: message.delivered,
      text: message.text,
    };
  }
}
