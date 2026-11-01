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
    this.attributes = data.attributes || {};

    if (data.start_time) {
      this.startTime = new Date(data.start_time);
    }
    if (data.end_time) {
      this.endTime = new Date(data.end_time);
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

export type AnomalyType = "CONTEXT_CANCELED" | "TOOL_LOOP" | "TOKEN_BLOAT" | "TOOL_ERROR" | "LATENCY_SPIKE";
export type AnomalySeverity = "CRITICAL" | "WARNING" | "INFO";

export interface Anomaly {
  type: AnomalyType;
  severity: AnomalySeverity;
  message: string;
  turnIndex?: number | null;
  traceId?: string | null;
  details?: Record<string, unknown>;
}

export interface AgentTurn {
  turnIndex: number;
  traceId: string;
  agentName: string;
  modelName: string;
  nostrEventId?: string | null;
  nostrReplyTo?: string | null;
  startTime?: Date;
  endTime?: Date;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
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
  total_turns: number;
  total_tokens: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_duration_ms: number;
  start_time: string | null;
  end_time: string | null;
  status: string;
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
    trace_id: string;
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
    };
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
  totalTurns: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalDurationMs: number;
  startTime?: Date;
  endTime?: Date;
  status: string;
  turns: AgentTurn[];
  anomalies: Anomaly[];

  constructor(init: Partial<ThreadTelemetry>) {
    this.threadId = init.threadId || "";
    this.project = init.project || "mobile";
    this.sessionId = init.sessionId || null;
    this.nostrThreadId = init.nostrThreadId || null;
    this.nostrChannelId = init.nostrChannelId || null;
    this.totalTurns = init.totalTurns || 0;
    this.totalTokens = init.totalTokens || 0;
    this.totalPromptTokens = init.totalPromptTokens || 0;
    this.totalCompletionTokens = init.totalCompletionTokens || 0;
    this.totalDurationMs = init.totalDurationMs || 0;
    this.startTime = init.startTime;
    this.endTime = init.endTime;
    this.status = init.status || "OK";
    this.turns = init.turns || [];
    this.anomalies = init.anomalies || [];
  }

  toJSON(): ThreadTelemetryJSON {
    return {
      thread_id: this.threadId,
      project: this.project,
      session_id: this.sessionId,
      nostr_thread_id: this.nostrThreadId || null,
      nostr_channel_id: this.nostrChannelId || null,
      total_turns: this.totalTurns,
      total_tokens: this.totalTokens,
      total_prompt_tokens: this.totalPromptTokens,
      total_completion_tokens: this.totalCompletionTokens,
      total_duration_ms: Number(this.totalDurationMs.toFixed(2)),
      start_time: this.startTime ? this.startTime.toISOString() : null,
      end_time: this.endTime ? this.endTime.toISOString() : null,
      status: this.status,
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
        trace_id: t.traceId,
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
        },
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
