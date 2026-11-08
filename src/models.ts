/**
 * Core domain models for thread telemetry, traces, spans, and anomalies.
 */

export interface SpanContext {
  span_id?: string;
  trace_id?: string;
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
 * A span time as a Date. Phoenix's SQLite stores naive UTC (`2026-11-08 01:13:33.096000`): JavaScript would read that as
 * the machine's local time, so a time without a zone is taken as UTC. A time that names its zone (`Z`, `+07:00`) is kept.
 */
export function parseSpanTime(value: string): Date {
  const text = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(text.replace(/^\d{4}-\d{2}-\d{2}/, ""));
  const parsed = new Date(hasZone ? text.replace(" ", "T") : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? new Date(text) : parsed;
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
 * - REPLY_TO: the message that started the turn replies to a message we can tie to that turn exactly — the message
 *   that started it, or (when telemetry records posted event ids) a message it posted;
 * - INFERRED: the message replies to an event no turn is known for (in a Buzz thread, almost always an agent's own
 *   reply), so the parent is the latest turn of the same thread that had finished by then;
 * - THREAD_ROOT: only the thread's root ties the turn to the turn the root started;
 * - TEMPORAL: ordering only.
 */
export type ThreadEdgeType = "REPLY_TO" | "INFERRED" | "THREAD_ROOT" | "TEMPORAL";

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

/** One call to a posting tool: when it ran, what it was given to say and which message it answered. */
export interface PostRecord {
  start: number;
  end: number;
  text: string | null;
  replyTo: string | null;
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
  /** The turn's posting calls (epoch milliseconds), used to match them with the relay's messages. */
  posts?: PostRecord[];
  /**
   * Messages the turn answered that did not start it: with steering, a message that arrives while a turn runs is injected
   * into it and never starts a trace. Excludes the thread's root, the trigger's parent and other turns' triggers.
   */
  steeredEventIds?: string[];
  parentTurnIndex?: number | null;
  /** How the parent was found; null for a root turn. */
  parentEdgeType?: ThreadEdgeType | null;
  /** Other turns that fit an INFERRED parent as well (they finished together, from other agents). */
  parentAlternatives?: number[];
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
  project: string;
  session_id: string | null;
  nostr_thread_id?: string | null;
  nostr_channel_id?: string | null;
  phoenix_ui_url?: string | null;
  phoenix_session_url?: string | null;
  /** Where the telemetry was read from: `sqlite:<path>` or the Phoenix endpoint. */
  source?: string | null;
  /** For a thread that was not found: every place that was looked in, and what each said. */
  tried?: string[];
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
    /** Messages that arrived while the turn was running and were answered by it (steering). */
    steered_event_ids?: string[];
    parent_turn_index?: number | null;
    /** How the parent was found: REPLY_TO (exact), INFERRED, THREAD_ROOT; null for a root turn. */
    parent_edge?: string | null;
    /** Other turns an INFERRED parent could equally have been. */
    parent_alternatives?: number[];
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
  project: string;
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
  /** Where the telemetry was read from (`sqlite:<path>` or the Phoenix endpoint); null when nothing was found. */
  source: string | null;
  /** When the relay's thread was joined in (`--messages`): how many messages were read and how many replies matched. */
  relayMessages: { read: number; linked: number } | null;
  /** Every place that was looked in for the thread, and what each said (kept for a NOT_FOUND). */
  sourcesTried: string[];

  constructor(init: Partial<ThreadTelemetry>) {
    this.threadId = init.threadId || "";
    this.project = init.project || "mobile";
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
    this.relayMessages = init.relayMessages ?? null;
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
        parent_turn_index: t.parentTurnIndex ?? null,
        parent_edge: t.parentEdgeType ?? null,
        ...(t.parentAlternatives && t.parentAlternatives.length > 0
          ? { parent_alternatives: t.parentAlternatives }
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
