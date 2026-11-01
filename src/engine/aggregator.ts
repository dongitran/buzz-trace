/**
 * Thread Telemetry Aggregator.
 * Assembles raw OpenTelemetry spans across multiple agent turns into a unified ThreadTelemetry timeline.
 */

import { AgentTurn, SpanNode, ThreadTelemetry, ToolExecution } from "../models.js";

export class ThreadAggregator {
  readonly threadId: string;
  readonly project: string;
  readonly sessionId?: string | null;

  constructor(threadId: string, project = "mobile", sessionId?: string | null) {
    this.threadId = threadId;
    this.project = project;
    this.sessionId = sessionId;
  }

  aggregate(spans: SpanNode[]): ThreadTelemetry {
    if (!spans || spans.length === 0) {
      return new ThreadTelemetry({
        threadId: this.threadId,
        project: this.project,
        sessionId: this.sessionId || null,
        status: "NOT_FOUND",
      });
    }

    // 1. Group spans by traceId
    const tracesMap = new Map<string, SpanNode[]>();
    for (const span of spans) {
      if (span.traceId) {
        const list = tracesMap.get(span.traceId) || [];
        list.push(span);
        tracesMap.set(span.traceId, list);
      }
    }

    // 2. Build AgentTurn for each trace
    const turns: AgentTurn[] = [];
    for (const [traceId, traceSpans] of tracesMap.entries()) {
      turns.push(this.buildTurn(traceId, traceSpans));
    }

    // 3. Sort turns chronologically
    turns.sort((a, b) => {
      const timeA = a.startTime ? a.startTime.getTime() : 0;
      const timeB = b.startTime ? b.startTime.getTime() : 0;
      return timeA - timeB;
    });

    // Assign sequential turnIndex
    for (let i = 0; i < turns.length; i++) {
      turns[i].turnIndex = i + 1;
    }

    // 4. Compute aggregate statistics
    const totalTokens = turns.reduce((acc, t) => acc + t.totalTokens, 0);
    const totalPromptTokens = turns.reduce((acc, t) => acc + t.promptTokens, 0);
    const totalCompletionTokens = turns.reduce((acc, t) => acc + t.completionTokens, 0);
    const totalDurationMs = turns.reduce((acc, t) => acc + t.durationMs, 0);

    const threadStart = turns.length > 0 ? turns[0].startTime : undefined;
    const threadEnd = turns.length > 0 ? turns[turns.length - 1].endTime : undefined;

    let overallStatus = "OK";
    if (turns.some((t) => t.statusCode === "ERROR")) {
      overallStatus = "ERROR";
    }

    let nostrThreadId: string | null = null;
    let nostrChannelId: string | null = null;

    for (const turn of turns) {
      for (const span of turn.spans) {
        if (!nostrThreadId && span.attributes["nostr.thread_id"]) {
          nostrThreadId = span.attributes["nostr.thread_id"] as string;
        }
        if (!nostrChannelId && span.attributes["nostr.channel_id"]) {
          nostrChannelId = span.attributes["nostr.channel_id"] as string;
        }
      }
    }

    const resolvedSessionId =
      this.sessionId ||
      (turns.length > 0 && turns[0].spans.length > 0
        ? (turns[0].spans[0].attributes["session.id"] as string)
        : null);

    return new ThreadTelemetry({
      threadId: this.threadId,
      project: this.project,
      sessionId: resolvedSessionId,
      nostrThreadId,
      nostrChannelId,
      totalTurns: turns.length,
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      totalDurationMs,
      startTime: threadStart,
      endTime: threadEnd,
      status: overallStatus,
      turns,
    });
  }

  private buildTurn(traceId: string, spans: SpanNode[]): AgentTurn {
    // Find root span
    let rootSpan: SpanNode | undefined = spans.find((s) => s.name === "agent_turn" || s.parentId === null);
    if (!rootSpan && spans.length > 0) {
      rootSpan = spans[0];
    }

    const turnStart = rootSpan?.startTime;
    const turnEnd = rootSpan?.endTime;
    const turnDuration = rootSpan?.durationMs || 0;
    const turnStatus = rootSpan?.statusCode || "OK";
    const turnMsg = rootSpan?.statusMessage || null;

    // Agent name and Nostr event attribution
    let agentName = "unknown-agent";
    let nostrEventId: string | null = null;
    let nostrReplyTo: string | null = null;

    if (rootSpan) {
      const attrs = rootSpan.attributes;
      agentName =
        (attrs["agent.id"] as string) ||
        (attrs["agent.name"] as string) ||
        (attrs["service.name"] as string) ||
        (attrs["agent_name"] as string) ||
        (attrs["community.agent"] as string) ||
        "phoenix-twin";

      nostrEventId = (attrs["nostr.event_id"] as string) || null;
      nostrReplyTo = (attrs["nostr.reply_to"] as string) || null;
    }

    let modelName = "unknown-model";
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let totalTokens = 0;

    let promptPreview = "";
    let responsePreview = "";
    const tools: ToolExecution[] = [];

    for (const span of spans) {
      const attrs = span.attributes;

      // Check for LLM span
      if (
        span.name.startsWith("llm:") ||
        ((span.spanKind === "LLM" || span.spanKind === "SPAN_KIND_INTERNAL") && "llm.model_name" in attrs)
      ) {
        modelName = (attrs["llm.model_name"] as string) || modelName;
        promptTokens += Number(attrs["llm.token_count.prompt"] || 0);
        completionTokens += Number(attrs["llm.token_count.completion"] || 0);
        reasoningTokens += Number(attrs["llm.token_count.completion_details.reasoning"] || 0);
        totalTokens += Number(attrs["llm.token_count.total"] || 0);
      }

      // Prompt and response previews
      if (!promptPreview && attrs["input.value"]) {
        const rawIn = String(attrs["input.value"]).trim();
        promptPreview = rawIn.length > 120 ? `${rawIn.slice(0, 120)}...` : rawIn;
      }
      if (!responsePreview && attrs["output.value"]) {
        const rawOut = String(attrs["output.value"]).trim();
        responsePreview = rawOut.length > 120 ? `${rawOut.slice(0, 120)}...` : rawOut;
      }

      // Check for Tool span
      if (
        span.name.startsWith("tool:") ||
        ((span.spanKind === "TOOL" || span.spanKind === "SPAN_KIND_INTERNAL") && "tool.name" in attrs)
      ) {
        const toolName = (attrs["tool.name"] as string) || span.name.replace(/^tool:/, "");
        const toolIn = String(attrs["input.value"] || "").slice(0, 80);
        const toolBytes = Number(attrs["tool.output_bytes"] || 0);

        tools.push({
          name: toolName,
          durationMs: span.durationMs,
          statusCode: span.statusCode,
          error: span.statusCode === "ERROR" ? span.statusMessage : null,
          inputSummary: toolIn,
          outputBytes: toolBytes,
          spanId: span.spanId,
        });
      }
    }

    if (totalTokens === 0 && (promptTokens > 0 || completionTokens > 0)) {
      totalTokens = promptTokens + completionTokens;
    }

    return {
      turnIndex: 0,
      traceId,
      agentName,
      modelName,
      nostrEventId,
      nostrReplyTo,
      startTime: turnStart,
      endTime: turnEnd,
      durationMs: turnDuration,
      promptTokens,
      completionTokens,
      reasoningTokens,
      totalTokens,
      statusCode: turnStatus,
      statusMessage: turnMsg,
      promptPreview,
      responsePreview,
      tools,
      spans,
    };
  }
}
