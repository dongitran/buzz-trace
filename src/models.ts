/**
 * Core domain models for thread telemetry, traces, spans, and anomalies.
 */

export interface SpanContext {
  span_id?: string;
  trace_id?: string;
}

/** A span event as Phoenix returns it: `{name, timestamp, attributes}`. */
export interface SpanEventData {
  name?: string;
  timestamp?: string;
  attributes?: Record<string, unknown>;
}

export interface SpanNodeData {
  id?: string;
  span_id?: string;
  trace_id?: string;
  context?: SpanContext;
  parent_id?: string | null;
  name?: string;
  span_kind?: string;
  start_time?: string;
  end_time?: string;
  status_code?: string;
  status_message?: string | null;
  attributes?: Record<string, unknown>;
  events?: SpanEventData[] | null;
}

export function flattenAttributes(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const res: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      Object.assign(res, flattenAttributes(v as Record<string, unknown>, key));
    } else {
      res[key] = v;
    }
  }
  return res;
}

/**
 * A span time as a Date. Phoenix's API names the zone of every time (`2026-11-08T01:13:33.096000+00:00`) and that is kept.
 * A time without a zone is read as UTC, never as the machine's local time, which JavaScript would otherwise assume: a span
 * must show the same instant on every machine.
 */
export function parseSpanTime(value: string): Date {
  const text = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(text.replace(/^\d{4}-\d{2}-\d{2}/, ""));
  const parsed = new Date(hasZone ? text.replace(" ", "T") : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? new Date(text) : parsed;
}

/** An event of a span, with its time as a Date and its attributes flattened the way a span's are. */
export interface SpanEventNode {
  name: string;
  time?: Date;
  attributes: Record<string, unknown>;
}

export class SpanNode {
  spanId: string;
  traceId: string;
  name: string;
  spanKind: string;
  startTime?: Date;
  endTime?: Date;
  durationMs: number;
  parentId?: string | null;
  statusCode: string;
  statusMessage?: string | null;
  attributes: Record<string, unknown>;
  events: SpanEventNode[];

  constructor(data: SpanNodeData) {
    this.spanId = data.context?.span_id || data.span_id || data.id || "";
    this.traceId = data.context?.trace_id || data.trace_id || "";
    this.name = data.name || "unknown_span";
    this.spanKind = data.span_kind || "SPAN_KIND_INTERNAL";
    this.parentId = data.parent_id || null;
    this.statusCode = data.status_code || "OK";
    this.statusMessage = data.status_message || null;
    const rawAttrs = data.attributes || {};
    this.attributes = { ...flattenAttributes(rawAttrs), ...rawAttrs };
    this.events = (Array.isArray(data.events) ? data.events : [])
      .filter((e): e is SpanEventData => Boolean(e) && typeof e === "object" && typeof e.name === "string")
      .map((e) => {
        const raw = e.attributes && typeof e.attributes === "object" ? e.attributes : {};
        return {
          name: e.name as string,
          time: typeof e.timestamp === "string" && e.timestamp ? parseSpanTime(e.timestamp) : undefined,
          attributes: { ...flattenAttributes(raw), ...raw },
        };
      });

    if (data.start_time) {
      this.startTime = parseSpanTime(data.start_time);
    }
    if (data.end_time) {
      this.endTime = parseSpanTime(data.end_time);
    }

    if (this.startTime && this.endTime) {
      this.durationMs = Math.max(0, this.endTime.getTime() - this.startTime.getTime());
    } else {
      this.durationMs = 0;
    }
  }
}

export interface ToolExecution {
  name: string;
  durationMs: number;
  statusCode: string;
  error?: string | null;
  inputSummary: string;
  outputBytes: number;
  spanId: string;
}

export type AnomalyType =
  | "CONTEXT_CANCELED"
  | "TOOL_LOOP"
  | "TOKEN_BLOAT"
  | "TOOL_ERROR"
  | "LATENCY_SPIKE"
  | "TOKEN_INFLATION"
  | "SLOW_TOOL"
  | "UNHANDLED_EXCEPTION"
  | "CLOCK_SKEW"
  | "CAUSAL_OVERLAP"
  | "INVALID_DURATION"
  | "AMBIGUOUS_PARENT"
  | "CONTEXT_GROWTH";
export type AnomalySeverity = "CRITICAL" | "WARNING" | "INFO";

export interface Anomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  message: string;
  turnIndex?: number | null;
  traceId?: string | null;
  details?: Record<string, unknown>;
}

/**
 * How a turn was linked to its parent turn:
 * - REPLY_TO: the message that started the turn replies to a message we can tie to a turn exactly: the message
 *   that started it, a message it took in while it ran, or a message it posted (recorded as `nostr.posted_event_id`);
 * - INFERRED: the message replies to one that no span names. Exactly one turn could have posted it (it had a reply call
 *   that could have created it, and no other message needs that call), so that turn is named, as an inference;
 * - AMBIGUOUS: the same, but several turns could have posted it. No parent is picked: `parentCandidates` lists them;
 * - THREAD_ROOT: only the thread's root ties the turn to the turn the root started;
 * - TEMPORAL: ordering only.
 */
export type ThreadEdgeType = "REPLY_TO" | "INFERRED" | "AMBIGUOUS" | "THREAD_ROOT" | "TEMPORAL";

/** What the parent message of a turn is known to be (see `AgentTurn.parentMessage`). */
export type ParentBasis = "posted" | "started" | "steered" | "inferred" | "ambiguous" | "thread_root" | "unknown";

export interface ParentMessage {
  /** The message the turn's trigger replies to (`nostr.reply_to_id`). */
  id: string;
  basis: ParentBasis;
  /** The turn that posted it, when that is known (recorded or inferred); null otherwise. */
  postedByTurn: number | null;
  /** The turns the basis names: those that started it, took it in, posted it, or (ambiguous) could have posted it. */
  turns: number[];
}

/** A message that was injected into a running turn (steered), and how buzz-trace knows of it. */
export interface SteeredMessage {
  eventId: string | null;
  /** What the person wrote (the block's `Content:` line), not the framing around it. */
  text: string | null;
  /** The sender's name, when the record or the block has a real one. */
  sender: string | null;
  senderPubkey: string | null;
  priority: string | null;
  /**
   * `steer.delivered`: false when the turn ended before the message was echoed to it or a result named it. Such a message is
   * not known to have been handled by that turn, so it is not counted and not linked to. Null where nothing says.
   */
  delivered: boolean | null;
  /** `steer.end_reason`: `echo`, `result` or `turn_end`. */
  endReason: string | null;
  /** When it was delivered to the turn (epoch milliseconds), if recorded. */
  at: number | null;
  /** `span`/`event`: recorded by the runtime (the contract). `reply_call`: only inferred from a reply call that answered it. */
  source: "span" | "event" | "reply_call";
}

export interface ThreadDAGEdge {
  fromTurnIndex: number;
  toTurnIndex: number;
  type: ThreadEdgeType;
}

export interface ThreadBranch {
  branchId: string;
  rootTurnIndex: number;
  turnIndices: number[];
}

export interface ThreadDAG {
  rootIndices: number[];
  edges: ThreadDAGEdge[];
  branches: ThreadBranch[];
}

/** One call to a posting tool: when it ran, what it was given to say, which message it answered and, if recorded, which it created. */
export interface PostRecord {
  spanId: string;
  start: number;
  end: number;
  text: string | null;
  replyTo: string | null;
  /** The id of the message the call created (`nostr.posted_event_id`), null when the span does not record it. */
  eventId: string | null;
}

export interface AgentTurn {
  turnIndex: number;
  traceId: string;
  traceUrl?: string | null;
  agentName: string;
  modelName: string;
  nostrEventId?: string | null;
  nostrReplyTo?: string | null;
  nostrRootId?: string | null;
  /** Who wrote the message that started the turn (`nostr.sender_name`, else the Buzz envelope's From). */
  senderName?: string | null;
  /** What the turn posted to the thread through a reply/send tool, in order. */
  postedTexts?: string[];
  /** Event ids of the messages the turn posted, when telemetry records them (`nostr.posted_event_id[s]`). */
  postedEventIds?: string[];
  /** Event ids the turn's reply calls answered (`reply_to`), in order. */
  answeredEventIds?: string[];
  /** The turn's posting calls (epoch milliseconds), each with the id of the message it created when that is recorded. */
  posts?: PostRecord[];
  /**
   * The messages that arrived while the turn ran and were injected into it (steered), in the order they arrived. Recorded
   * by the runtime as `steer` spans or events, or, where nothing recorded them, inferred from a reply call that answered
   * a message other than the one that started the turn. Never holds the opening message.
   */
  steered?: SteeredMessage[];
  /** The ids of the steered messages the turn handled, where known. Excludes the thread's root, the trigger's parent, other turns' triggers and messages that were not delivered. */
  steeredEventIds?: string[];
  /** The messages the turn handled: the one that started it, plus the steered ones that were delivered to it. */
  handledMessages?: number;
  /** The runtime stopped writing steer spans for this turn after a number of them (`steer_spans_capped`): the list of steered messages is not complete. */
  steerCapped?: boolean;
  /**
   * Whether a steered message would have shown in this turn's trace: it has a `steer` record, or a recorded posted id (a
   * runtime that writes ids writes steer spans), or another turn of the same agent in the thread has either. False for a trace
   * written before the contract: there, a steered message that no reply call answered is simply absent.
   */
  steeringRecorded?: boolean;
  parentTurnIndex?: number | null;
  /** How the parent was found; null for a root turn, and for an AMBIGUOUS one (see `parentCandidates`). */
  parentEdgeType?: ThreadEdgeType | null;
  /** AMBIGUOUS: the turns that could each have posted the parent message, in turn order. No parent is picked. */
  parentCandidates?: number[];
  /** What the message this turn replies to is known to be: who posted it, or who could have. Absent for a turn that replies to nothing. */
  parentMessage?: ParentMessage;
  depth?: number;
  branchId?: string;
  childrenTurnIndices?: number[];
  startTime?: Date;
  endTime?: Date;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /**
   * Model calls the turn made, estimated as one more than its steps of tools (tools that ran together are one step).
   * A turn's prompt tokens are summed over all of its calls; this is what they are divided by.
   */
  modelCalls?: number;
  /** Prompt tokens of one model call, estimated: the turn's prompt tokens over `modelCalls`. */
  contextPerCall?: number;
  /** Tokens of the text that started the turn (its root span's input): what the next round adds to the history. */
  inputTextTokens?: number;
  /** Prompt tokens served from / written to the model's prompt cache (`llm.token_count.prompt_details.*`). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** The turn's model cost in USD (`llm.cost.total`), counted once. */
  costUsd?: number;
  statusCode: string;
  statusMessage?: string | null;
  promptPreview: string;
  responsePreview: string;
  tools: ToolExecution[];
  spans: SpanNode[];
}

export interface ThreadTelemetryJSON {
  thread_id: string;
  /** The project the thread was found in (the one named, else the one Phoenix says holds it); null when not found. */
  project: string | null;
  session_id: string | null;
  nostr_thread_id?: string | null;
  nostr_channel_id?: string | null;
  phoenix_ui_url?: string | null;
  phoenix_session_url?: string | null;
  /** Where the telemetry was read from: the Phoenix endpoint. */
  source?: string | null;
  /** For a thread that was not found: every place that was looked in, and what each said. */
  tried?: string[];
  /** `recorded` when a steered message would show in the trace (a `steer` record, or a runtime that writes the contract); `not_recorded` when none of the turns shows any sign of that. */
  steering?: "recorded" | "not_recorded";
  total_turns: number;
  total_tokens: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_duration_ms: number;
  /** Model cost of the whole thread in USD, each turn counted once (null when no turn reported one). */
  total_cost_usd?: number | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
  dag?: {
    root_indices: number[];
    edges: Array<{
      from_turn_index: number;
      to_turn_index: number;
      type: string;
    }>;
    branches: Array<{
      branch_id: string;
      root_turn_index: number;
      turn_indices: number[];
    }>;
  };
  anomalies: Array<{
    type: string;
    severity: string;
    message: string;
    turn_index?: number | null;
    trace_id?: string | null;
    details?: Record<string, unknown>;
  }>;
  turns: Array<{
    turn_index: number;
    /** The Buzz message that started the turn, what it replies to, and the thread's root. */
    event_id?: string | null;
    reply_to?: string | null;
    root_id?: string | null;
    /** Who wrote the message that started the turn. */
    sender?: string | null;
    /** Messages that arrived while the turn was running and were injected into it (steering): their ids, where known. */
    steered_event_ids?: string[];
    /** The same messages with their text, sender, priority and time, and whether the runtime recorded them (`source`). */
    steered?: Array<{
      event_id: string | null;
      text: string | null;
      sender: string | null;
      sender_pubkey?: string | null;
      priority: string | null;
      at: string | null;
      source: string;
      /** False: the turn ended before the message reached it (not counted in `handled_messages`). Absent when nothing says. */
      delivered?: boolean;
      end_reason?: string;
    }>;
    /** Messages the turn handled: the one that started it plus the steered ones that were delivered. */
    handled_messages?: number;
    /** True when the list of steered messages is cut short (the runtime caps the steer spans of a turn). */
    steered_capped?: boolean;
    /** Whether a steered message would have shown in this turn's trace (see AgentTurn.steeringRecorded). */
    steering_recorded?: boolean;
    /** The ids of the messages the turn posted, as far as the spans record them (see `posts`). */
    posted_event_ids?: string[];
    /** Each posting call: the message it created (null when not recorded), the one it answered, its text and time. */
    posts?: Array<{ event_id: string | null; reply_to: string | null; text: string | null; at: string }>;
    /** The ids of the messages the turn's reply calls answered. */
    answered_event_ids?: string[];
    parent_turn_index?: number | null;
    /** How the parent was found: REPLY_TO (exact), INFERRED, AMBIGUOUS (none picked), THREAD_ROOT; null for a root turn. */
    parent_edge?: string | null;
    /** AMBIGUOUS: the turns that could have posted the parent message. */
    parent_candidates?: number[];
    /** Same as `parent_candidates`; the name 0.3 used for the other turns an inferred parent could have been. */
    parent_alternatives?: number[];
    /** The message the turn replies to, how it is known, and who posted it (or who could have). */
    parent_message?: { id: string; basis: string; posted_by_turn: number | null; turns: number[] };
    depth?: number;
    branch_id?: string;
    children_turn_indices?: number[];
    trace_id: string;
    trace_url?: string | null;
    agent: string;
    model: string;
    status: string;
    status_message: string | null;
    duration_ms: number;
    tokens: {
      prompt: number;
      completion: number;
      reasoning: number;
      total: number;
      cache_read?: number;
      cache_write?: number;
    };
    /** Estimated model calls of the turn and the prompt tokens of one call (see AgentTurn.modelCalls). */
    model_calls?: number;
    context_per_call?: number | null;
    cost_usd?: number | null;
    /** What the turn posted to the thread, in order. */
    posted?: string[];
    prompt_preview: string;
    response_preview: string;
    tools: Array<{
      name: string;
      status: string;
      duration_ms: number;
      input_summary: string;
      output_bytes: number;
      error?: string | null;
    }>;
  }>;
}

export class ThreadTelemetry {
  threadId: string;
  /** The project the thread was found in; null when it was not named and the thread was not found. */
  project: string | null;
  sessionId: string | null;
  nostrThreadId?: string | null;
  nostrChannelId?: string | null;
  phoenixUiUrl?: string | null;
  phoenixSessionUrl?: string | null;
  totalTurns: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalDurationMs: number;
  /** Model cost of the whole thread in USD; null when no turn reported one. */
  totalCostUsd: number | null;
  startTime?: Date;
  endTime?: Date;
  status: string;
  dag?: ThreadDAG;
  turns: AgentTurn[];
  anomalies: Anomaly[];
  /** Where the telemetry was read from (the Phoenix endpoint); null when nothing was found. */
  source: string | null;
  /** Whether a steered message would show in this thread's trace: some turn has a `steer` record or shows that its runtime writes the contract. When false, one that arrived mid-turn is simply absent. */
  steeringRecorded: boolean;
  /** Every place that was looked in for the thread, and what each said (kept for a NOT_FOUND). */
  sourcesTried: string[];

  constructor(init: Partial<ThreadTelemetry>) {
    this.threadId = init.threadId || "";
    this.project = init.project || null;
    this.sessionId = init.sessionId || null;
    this.nostrThreadId = init.nostrThreadId || null;
    this.nostrChannelId = init.nostrChannelId || null;
    this.phoenixUiUrl = init.phoenixUiUrl || null;
    this.phoenixSessionUrl = init.phoenixSessionUrl || null;
    this.totalTurns = init.totalTurns || 0;
    this.totalTokens = init.totalTokens || 0;
    this.totalPromptTokens = init.totalPromptTokens || 0;
    this.totalCompletionTokens = init.totalCompletionTokens || 0;
    this.totalDurationMs = init.totalDurationMs || 0;
    this.totalCostUsd = init.totalCostUsd ?? null;
    this.startTime = init.startTime;
    this.endTime = init.endTime;
    this.status = init.status || "OK";
    this.dag = init.dag;
    this.turns = init.turns || [];
    this.anomalies = init.anomalies || [];
    this.source = init.source ?? null;
    this.steeringRecorded = init.steeringRecorded ?? false;
    this.sourcesTried = init.sourcesTried ?? [];
  }

  toJSON(): ThreadTelemetryJSON {
    return {
      thread_id: this.threadId,
      project: this.project,
      session_id: this.sessionId,
      nostr_thread_id: this.nostrThreadId || null,
      nostr_channel_id: this.nostrChannelId || null,
      phoenix_ui_url: this.phoenixUiUrl || null,
      phoenix_session_url: this.phoenixSessionUrl || null,
      source: this.source,
      ...(this.status === "NOT_FOUND" && this.sourcesTried.length > 0 ? { tried: this.sourcesTried } : {}),
      ...(this.turns.length > 0 ? { steering: this.steeringRecorded ? ("recorded" as const) : ("not_recorded" as const) } : {}),
      total_turns: this.totalTurns,
      total_tokens: this.totalTokens,
      total_prompt_tokens: this.totalPromptTokens,
      total_completion_tokens: this.totalCompletionTokens,
      total_duration_ms: Number(this.totalDurationMs.toFixed(2)),
      total_cost_usd: this.totalCostUsd,
      start_time: this.startTime ? this.startTime.toISOString() : null,
      end_time: this.endTime ? this.endTime.toISOString() : null,
      status: this.status,
      dag: this.dag
        ? {
            root_indices: this.dag.rootIndices,
            edges: this.dag.edges.map((e) => ({
              from_turn_index: e.fromTurnIndex,
              to_turn_index: e.toTurnIndex,
              type: e.type,
            })),
            branches: this.dag.branches.map((b) => ({
              branch_id: b.branchId,
              root_turn_index: b.rootTurnIndex,
              turn_indices: b.turnIndices,
            })),
          }
        : undefined,
      anomalies: this.anomalies.map((a) => ({
        type: a.type,
        severity: a.severity,
        message: a.message,
        turn_index: a.turnIndex,
        trace_id: a.traceId,
        details: a.details,
      })),
      turns: this.turns.map((t) => ({
        turn_index: t.turnIndex,
        event_id: t.nostrEventId ?? null,
        reply_to: t.nostrReplyTo ?? null,
        root_id: t.nostrRootId ?? null,
        sender: t.senderName ?? null,
        ...(t.steeredEventIds && t.steeredEventIds.length > 0 ? { steered_event_ids: t.steeredEventIds } : {}),
        ...(t.steered && t.steered.length > 0
          ? {
              steered: t.steered.map((m) => ({
                event_id: m.eventId,
                text: m.text,
                sender: m.sender,
                ...(m.senderPubkey ? { sender_pubkey: m.senderPubkey } : {}),
                priority: m.priority,
                at: m.at === null ? null : new Date(m.at).toISOString(),
                source: m.source,
                ...(m.delivered === null ? {} : { delivered: m.delivered }),
                ...(m.endReason ? { end_reason: m.endReason } : {}),
              })),
            }
          : {}),
        handled_messages: t.handledMessages ?? 1,
        ...(t.steerCapped ? { steered_capped: true } : {}),
        steering_recorded: t.steeringRecorded ?? false,
        posted_event_ids: t.postedEventIds ?? [],
        posts: (t.posts ?? []).map((p) => ({
          event_id: p.eventId,
          reply_to: p.replyTo,
          text: p.text,
          at: new Date(p.start).toISOString(),
        })),
        answered_event_ids: t.answeredEventIds ?? [],
        parent_turn_index: t.parentTurnIndex ?? null,
        parent_edge: t.parentEdgeType ?? null,
        ...(t.parentCandidates && t.parentCandidates.length > 0
          ? { parent_candidates: t.parentCandidates, parent_alternatives: t.parentCandidates }
          : {}),
        ...(t.parentMessage
          ? {
              parent_message: {
                id: t.parentMessage.id,
                basis: t.parentMessage.basis,
                posted_by_turn: t.parentMessage.postedByTurn,
                turns: t.parentMessage.turns,
              },
            }
          : {}),
        depth: t.depth ?? 0,
        branch_id: t.branchId || "main",
        children_turn_indices: t.childrenTurnIndices || [],
        trace_id: t.traceId,
        trace_url: t.traceUrl || null,
        agent: t.agentName,
        model: t.modelName,
        status: t.statusCode,
        status_message: t.statusMessage || null,
        duration_ms: Number(t.durationMs.toFixed(2)),
        tokens: {
          prompt: t.promptTokens,
          completion: t.completionTokens,
          reasoning: t.reasoningTokens,
          total: t.totalTokens,
          ...(t.cacheReadTokens ? { cache_read: t.cacheReadTokens } : {}),
          ...(t.cacheWriteTokens ? { cache_write: t.cacheWriteTokens } : {}),
        },
        model_calls: t.modelCalls ?? 1,
        context_per_call: t.contextPerCall ?? null,
        cost_usd: t.costUsd ?? null,
        posted: t.postedTexts && t.postedTexts.length > 0 ? t.postedTexts : [],
        prompt_preview: t.promptPreview,
        response_preview: t.responsePreview,
        tools: t.tools.map((tool) => ({
          name: tool.name,
          status: tool.statusCode,
          duration_ms: Number(tool.durationMs.toFixed(2)),
          input_summary: tool.inputSummary,
          output_bytes: tool.outputBytes,
          error: tool.error || null,
        })),
      })),
    };
  }
}
