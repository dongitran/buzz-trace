/**
 * Thread Telemetry Aggregator.
 * Assembles raw OpenTelemetry spans across multiple agent turns into a unified ThreadTelemetry timeline.
 */

import {
  AgentTurn,
  Anomaly,
  PostRecord,
  SpanNode,
  ThreadBranch,
  ThreadDAG,
  ThreadDAGEdge,
  type ThreadEdgeType,
  ThreadTelemetry,
  ToolExecution,
} from "../models.js";
import { extractSemanticToolInput } from "../formatters/compact-fmt.js";
import { type BuzzEnvelope, parseBuzzEnvelope } from "./envelope.js";
import { linkPostedMessages, type ThreadMessage } from "./messages.js";
import { countTokens } from "../tokenizer.js";

const PREVIEW_CHARS = 120;
/** A child that starts this soon after its candidate parent ended still counts as after it (container clock drift). */
const INFER_SKEW_TOLERANCE_MS = 2000;
/** Candidates from other agents that ended this close to the chosen parent make an inferred parent ambiguous. */
const AMBIGUITY_WINDOW_MS = 5000;
const HEX64 = /^[0-9a-f]{64}$/i;

/** A finite number from a span attribute, else undefined (an absent cost is not a cost of zero). */
function numeric(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {return undefined;}
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Model calls a turn made, from the time its tools ran: each step of tools needs one more call to read their results,
 * and tools that overlap in time ran in the same step. A turn with no tool made one call.
 */
export function countModelCalls(toolWindows: Array<[number, number]>): number {
  const sorted = [...toolWindows].sort((a, b) => a[0] - b[0]);
  let steps = 0;
  let stepEnd = Number.NEGATIVE_INFINITY;
  for (const [start, end] of sorted) {
    if (start >= stepEnd) {
      steps += 1;
      stepEnd = end;
    } else {
      stepEnd = Math.max(stepEnd, end);
    }
  }
  return steps + 1;
}

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PREVIEW_CHARS ? `${trimmed.slice(0, PREVIEW_CHARS)}...` : trimmed;
}

/** Event ids a span says its turn posted: `nostr.posted_event_id` (one) or `nostr.posted_event_ids` (list or CSV). */
function postedIdsOf(attrs: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string") {
      for (const part of v.split(",")) {
        const idv = part.trim();
        if (idv) {out.push(HEX64.test(idv) ? idv.toLowerCase() : idv);}
      }
    } else if (Array.isArray(v)) {
      v.forEach(add);
    }
  };
  add(attrs["nostr.posted_event_id"]);
  add(attrs["nostr.posted_event_ids"]);
  return out;
}

const endMs = (t: AgentTurn) => (t.endTime ? t.endTime.getTime() : t.startTime ? t.startTime.getTime() : 0);

/** Among turns started by the same message, the one a reply most likely continues: the same agent's, else the latest. */
function pickTriggered(options: AgentTurn[], child: AgentTurn): AgentTurn {
  const same = options.filter((t) => t.agentName === child.agentName);
  const pool = same.length > 0 ? same : options;
  return pool.reduce((best, t) => (endMs(t) > endMs(best) ? t : best));
}

/**
 * The turn a turn continues, and how that was found (see ThreadEdgeType). A turn is never the parent of a turn the
 * same message started: those are siblings.
 */
function resolveParent(
  turn: AgentTurn,
  all: AgentTurn[],
  byTrigger: Map<string, AgentTurn[]>,
  byPosted: Map<string, AgentTurn>,
  bySteered: Map<string, AgentTurn>,
): { parent?: AgentTurn; type: ThreadEdgeType | null; alternatives: AgentTurn[] } {
  const isSiblingOrSelf = (t: AgentTurn) =>
    t === turn || (Boolean(turn.nostrEventId) && t.nostrEventId === turn.nostrEventId);
  const replyTo = turn.nostrReplyTo || null;
  const root = turn.nostrRootId || null;

  // 1. Exact: it answers a message a turn posted, or a message that started another turn.
  if (replyTo) {
    const poster = byPosted.get(replyTo);
    if (poster && !isSiblingOrSelf(poster)) {
      return { parent: poster, type: "REPLY_TO", alternatives: [] };
    }
    const started = (byTrigger.get(replyTo) || []).filter((t) => !isSiblingOrSelf(t));
    if (started.length > 0) {
      return { parent: pickTriggered(started, turn), type: "REPLY_TO", alternatives: [] };
    }
    // A message steered into a running turn started no turn, but that turn answered it.
    const handler = bySteered.get(replyTo);
    if (handler && !isSiblingOrSelf(handler)) {
      return { parent: handler, type: "REPLY_TO", alternatives: [] };
    }
  }

  // 2. Inferred: a reply inside a thread to an event no turn is known for — in a Buzz thread, almost always an agent's
  // own reply. The latest turn of this thread that had finished by then (and posted something, when any did) wrote it.
  const inThread = Boolean(root) && root !== turn.nostrEventId;
  const start = turn.startTime ? turn.startTime.getTime() : null;
  if (replyTo && inThread && start !== null) {
    const finished = all.filter(
      (t) =>
        !isSiblingOrSelf(t) &&
        (t.nostrEventId === root || t.nostrRootId === root) &&
        // A reply starts after its parent started, so the parents of inferred links can never form a cycle.
        t.startTime !== undefined &&
        t.startTime.getTime() < start &&
        endMs(t) <= start + INFER_SKEW_TOLERANCE_MS,
    );
    const posting = finished.filter((t) => (t.postedTexts?.length ?? 0) > 0 || (t.postedEventIds?.length ?? 0) > 0);
    const pool = (posting.length > 0 ? posting : finished).sort((a, b) => endMs(b) - endMs(a));
    if (pool.length > 0) {
      const chosen = pool[0];
      const alternatives = pool
        .slice(1)
        .filter((t) => t.agentName !== chosen.agentName && endMs(chosen) - endMs(t) <= AMBIGUITY_WINDOW_MS);
      return { parent: chosen, type: "INFERRED", alternatives };
    }
  }

  // 3. Only the thread's root ties it to a turn.
  if (inThread && root) {
    const started = (byTrigger.get(root) || []).filter((t) => !isSiblingOrSelf(t));
    if (started.length > 0) {
      return { parent: pickTriggered(started, turn), type: "THREAD_ROOT", alternatives: [] };
    }
  }

  return { type: null, alternatives: [] };
}

/** The command line a shell-like tool ran: a `command`/`CommandLine` parameter, or the same key inside a JSON input. */
function shellCommandOf(attrs: Record<string, unknown>): string | null {
  for (const key of ["tool.parameters.command", "tool.parameters.CommandLine", "tool.parameters.cmd"]) {
    const direct = attrs[key];
    if (typeof direct === "string" && direct.trim()) {
      return direct;
    }
  }
  const raw = attrs["input.value"];
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["command", "CommandLine", "cmd"]) {
      if (typeof parsed[key] === "string") {
        return parsed[key] as string;
      }
    }
    return null;
  } catch {
    return raw;
  }
}

/** What a posting tool call wrote and which message it answered; null when the call posts nothing to the thread. */
interface PostCall {
  text: string | null;
  replyTo: string | null;
}

const ID_IN_FLAG = /--reply-to\s+(?:"([0-9a-fA-F]{64})"|'([0-9a-fA-F]{64})'|([0-9a-fA-F]{64}))/;

/** A tool that posts to the thread: MCP `…__reply` / `…__send` / `…__post…`, or a shell running `buzz messages send`. */
function postOf(toolName: string, attrs: Record<string, unknown>): PostCall | null {
  const base = (toolName.split("__").pop() || toolName).toLowerCase();
  const posts = /^(reply|send|post)(_|$)|^(send|post)_message$/.test(base);
  if (posts) {
    let json: Record<string, unknown> = {};
    const raw = attrs["input.value"];
    if (typeof raw === "string") {
      try {
        json = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // not JSON: the parameters come from the tool.parameters.* attributes
      }
    }
    const pick = (...values: unknown[]) => values.find((v) => typeof v === "string" && v.trim()) as string | undefined;
    const text = pick(attrs["tool.parameters.text"], attrs["tool.parameters.content"], attrs["tool.parameters.message"], json.text, json.content, json.message);
    const target = pick(attrs["tool.parameters.reply_to"], attrs["tool.parameters.replyTo"], json.reply_to, json.replyTo);
    return { text: text ? text.trim() : null, replyTo: target && HEX64.test(target.trim()) ? target.trim().toLowerCase() : null };
  }
  const command = shellCommandOf(attrs);
  if (command && /\bbuzz\b[^\n]*\bmessages\s+send\b/.test(command)) {
    // A closing quote may be missing: telemetry cuts long inputs and marks the cut with an ellipsis.
    const m = /--content\s+(?:"((?:[^"\\]|\\.)*)(?:"|$)|'([^']*)(?:'|$))/.exec(command);
    const raw = m ? (m[1] !== undefined ? m[1].replace(/\\(["\\$`])/g, "$1") : m[2]) : null;
    const text = raw ? raw.replace(/…$/, "") : null;
    const target = ID_IN_FLAG.exec(command);
    const id = target ? (target[1] ?? target[2] ?? target[3]).toLowerCase() : null;
    return { text: text && text.trim() ? text.trim() : null, replyTo: id };
  }
  return null;
}

export class ThreadAggregator {
  readonly threadId: string;
  readonly project: string;
  readonly sessionId?: string | null;
  readonly phoenixUiUrl?: string | null;

  constructor(threadId: string, project = "mobile", sessionId?: string | null, phoenixUiUrl?: string | null) {
    this.threadId = threadId;
    this.project = project;
    this.sessionId = sessionId;
    this.phoenixUiUrl = phoenixUiUrl;
  }

  aggregate(spans: SpanNode[], options: { messages?: ThreadMessage[] } = {}): ThreadTelemetry {
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
    const rawTurns: AgentTurn[] = [];
    for (const [traceId, traceSpans] of tracesMap.entries()) {
      rawTurns.push(this.buildTurn(traceId, traceSpans));
    }

    // 2-. The relay's messages, when given: match each reply call with the message it created, so the event ids of what
    // every turn posted are known and the links between turns are exact.
    const relayMessages = options.messages ? { read: options.messages.length, linked: linkPostedMessages(rawTurns, options.messages) } : null;

    // 2a. Messages a turn answered that did not start it (steered into the running turn). The thread's root, the
    // trigger's parent and the triggers of other turns are answers to messages the thread already had a turn for.
    const triggers = new Set(rawTurns.map((t) => t.nostrEventId).filter((id): id is string => Boolean(id)));
    for (const turn of rawTurns) {
      turn.steeredEventIds = (turn.answeredEventIds ?? []).filter(
        (id) => id !== turn.nostrEventId && id !== turn.nostrRootId && id !== turn.nostrReplyTo && !triggers.has(id),
      );
    }

    // 2b. Detect INVALID_DURATION (monotonic clock jumps where start_time > end_time)
    const invalidDurationAnomalies: Anomaly[] = [];
    for (const span of spans) {
      if (span.startTime && span.endTime && span.startTime.getTime() > span.endTime.getTime()) {
        const negativeMs = span.startTime.getTime() - span.endTime.getTime();
        invalidDurationAnomalies.push({
          type: "INVALID_DURATION",
          severity: "WARNING",
          message: `Invalid span duration detected: span '${span.name}' has startTime (${span.startTime.toISOString()}) later than endTime (${span.endTime.toISOString()}) by ${negativeMs}ms due to monotonic clock jump.`,
          traceId: span.traceId,
          details: {
            spanId: span.spanId,
            spanName: span.name,
            negativeDurationMs: -negativeMs,
            startTime: span.startTime.toISOString(),
            endTime: span.endTime.toISOString(),
          },
        });
      }
    }

    // 3. Sort turns topologically (causality-first, clock-skew resilient) and build thread DAG
    const { turns, dag, anomalies: orderingAnomalies } = this.orderTurnsAndBuildDAG(rawTurns, invalidDurationAnomalies);

    // 4. Compute aggregate statistics
    const totalTokens = turns.reduce((acc, t) => acc + t.totalTokens, 0);
    const totalPromptTokens = turns.reduce((acc, t) => acc + t.promptTokens, 0);
    const totalCompletionTokens = turns.reduce((acc, t) => acc + t.completionTokens, 0);
    const totalDurationMs = turns.reduce((acc, t) => acc + t.durationMs, 0);
    const costed = turns.filter((t) => t.costUsd !== undefined);
    const totalCostUsd = costed.length > 0 ? costed.reduce((acc, t) => acc + (t.costUsd ?? 0), 0) : null;

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
      totalCostUsd,
      startTime: threadStart,
      endTime: threadEnd,
      status: overallStatus,
      dag,
      turns,
      anomalies: orderingAnomalies,
      relayMessages,
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
    let nostrRootId: string | null = null;
    let senderName: string | null = null;
    let envelope: BuzzEnvelope | null = null;

    if (rootSpan) {
      const attrs = rootSpan.attributes;
      agentName =
        (attrs["agent.id"] as string) ||
        (attrs["agent.name"] as string) ||
        (attrs["service.name"] as string) ||
        (attrs["agent_name"] as string) ||
        (attrs["community.agent"] as string) ||
        "phoenix-twin";

      envelope = parseBuzzEnvelope(attrs["input.value"] as string | undefined);

      nostrEventId =
        (attrs["nostr.event_id"] as string) ||
        (attrs["event_id"] as string) ||
        envelope?.eventId ||
        null;

      nostrReplyTo =
        (attrs["nostr.reply_to"] as string) ||
        (attrs["nostr.reply_to_id"] as string) ||
        (attrs["reply_to"] as string) ||
        envelope?.parentId ||
        null;

      nostrRootId =
        (attrs["nostr.root_id"] as string) ||
        (attrs["nostr.thread_root_id"] as string) ||
        (attrs["nostr.root"] as string) ||
        envelope?.rootId ||
        null;

      senderName = (attrs["nostr.sender_name"] as string) || envelope?.senderName || null;

      if (!nostrRootId && attrs["input.value"]) {
        const inStr = String(attrs["input.value"]);
        const rootMatch =
          inStr.match(/Thread root:\s*([0-9a-fA-F]{64})/) ||
          inStr.match(/root=([0-9a-fA-F]{64})/) ||
          inStr.match(/\["e",\s*"([0-9a-fA-F]{64})",\s*".*?",\s*"root"\]/);
        if (rootMatch) {
          nostrRootId = rootMatch[1];
        }
      }
    }

    let modelName = "unknown-model";
    if (rootSpan) {
      const rootModel =
        (rootSpan.attributes["llm.model_name"] as string) ||
        (rootSpan.attributes["llm.model"] as string) ||
        (rootSpan.attributes["gen_ai.request.model"] as string) ||
        (rootSpan.attributes["model"] as string);
      if (rootModel) {
        modelName = rootModel;
      }
    }

    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let totalTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    // Cost: the fork writes the turn's cost on the root span and again on its LLM span, so count it once — the root's
    // when it has one, else the sum over LLM spans.
    const rootCost = rootSpan ? numeric(rootSpan.attributes["llm.cost.total"]) : undefined;
    let llmCost = 0;
    let sawLlmCost = false;

    let promptPreview = envelope?.content ? preview(envelope.content) : "";
    let responsePreview = "";
    const tools: ToolExecution[] = [];
    const postedTexts: string[] = [];
    const postedEventIds: string[] = [];
    const answeredEventIds: string[] = [];
    const posts: PostRecord[] = [];
    const toolWindows: Array<[number, number]> = [];

    for (const span of spans) {
      const attrs = span.attributes;
      for (const posted of postedIdsOf(attrs)) {
        if (!postedEventIds.includes(posted)) {postedEventIds.push(posted);}
      }

      // Check for LLM span
      const detectedModel =
        (attrs["llm.model_name"] as string) ||
        (attrs["llm.model"] as string) ||
        (attrs["gen_ai.request.model"] as string) ||
        (attrs["model"] as string);

      if (
        span.name.startsWith("llm:") ||
        span.spanKind === "LLM" ||
        detectedModel !== undefined
      ) {
        if (detectedModel) {
          modelName = detectedModel;
        }
        promptTokens += Number(attrs["llm.token_count.prompt"] || 0);
        completionTokens += Number(attrs["llm.token_count.completion"] || 0);
        reasoningTokens += Number(attrs["llm.token_count.completion_details.reasoning"] || 0);
        totalTokens += Number(attrs["llm.token_count.total"] || 0);
        cacheReadTokens += Number(attrs["llm.token_count.prompt_details.cache_read"] || 0);
        cacheWriteTokens += Number(attrs["llm.token_count.prompt_details.cache_write"] || 0);
        const spanCost = numeric(attrs["llm.cost.total"]);
        if (spanCost !== undefined) {
          llmCost += spanCost;
          sawLlmCost = true;
        }
      }

      const isToolSpan =
        span.name.startsWith("tool:") ||
        ((span.spanKind === "TOOL" || span.spanKind === "SPAN_KIND_INTERNAL") && "tool.name" in attrs);

      // Prompt and response previews (from agent turn or non-tool spans)
      if (!isToolSpan) {
        if (!promptPreview && attrs["input.value"]) {
          const rawIn = String(attrs["input.value"]).trim();
          promptPreview = rawIn.length > 120 ? `${rawIn.slice(0, 120)}...` : rawIn;
        }
        if (!responsePreview && attrs["output.value"]) {
          const rawOut = String(attrs["output.value"]).trim();
          responsePreview = rawOut.length > 120 ? `${rawOut.slice(0, 120)}...` : rawOut;
        }
      }

      // Check for Tool span
      if (isToolSpan) {
        const toolName = (attrs["tool.name"] as string) || span.name.replace(/^tool:/, "");
        const rawToolIn = attrs["input.value"];
        const semanticIn = extractSemanticToolInput(rawToolIn);
        const toolIn = semanticIn.length > 80 ? semanticIn.slice(0, 80) : semanticIn;
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

        if (span.startTime) {
          toolWindows.push([span.startTime.getTime(), (span.endTime ?? span.startTime).getTime()]);
        }
        if (span.statusCode !== "ERROR") {
          const post = postOf(toolName, attrs);
          if (post?.text) {
            postedTexts.push(post.text);
          }
          if (post?.replyTo && !answeredEventIds.includes(post.replyTo)) {
            answeredEventIds.push(post.replyTo);
          }
          if (post && span.startTime) {
            posts.push({
              start: span.startTime.getTime(),
              end: (span.endTime ?? span.startTime).getTime(),
              text: post.text,
              replyTo: post.replyTo,
            });
          }
        }
      }
    }

    const modelCalls = countModelCalls(toolWindows);

    // What the agent posted is what the thread saw; the model's closing aside ("I replied in the thread…") is not.
    if (postedTexts.length > 0) {
      responsePreview = preview(postedTexts[postedTexts.length - 1]);
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
      nostrRootId,
      senderName,
      postedTexts,
      postedEventIds,
      answeredEventIds,
      posts,
      startTime: turnStart,
      endTime: turnEnd,
      durationMs: turnDuration,
      promptTokens,
      completionTokens,
      reasoningTokens,
      totalTokens,
      modelCalls,
      contextPerCall: promptTokens > 0 ? Math.round(promptTokens / modelCalls) : undefined,
      inputTextTokens: typeof rootSpan?.attributes["input.value"] === "string" ? countTokens(rootSpan.attributes["input.value"] as string) : 0,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: rootCost ?? (sawLlmCost ? llmCost : undefined),
      statusCode: turnStatus,
      statusMessage: turnMsg,
      promptPreview,
      responsePreview,
      tools,
      spans,
    };
  }

  private orderTurnsAndBuildDAG(
    rawTurns: AgentTurn[],
    additionalAnomalies: Anomaly[] = [],
  ): {
    turns: AgentTurn[];
    dag: ThreadDAG;
    anomalies: Anomaly[];
  } {
    if (rawTurns.length === 0) {
      return {
        turns: [],
        dag: { rootIndices: [], edges: [], branches: [] },
        anomalies: additionalAnomalies,
      };
    }

    // Index turns by the message that started them (several agents can be started by one message) and by the
    // messages they posted (when telemetry records posted event ids).
    const byTrigger = new Map<string, AgentTurn[]>();
    const byPosted = new Map<string, AgentTurn>();
    const bySteered = new Map<string, AgentTurn>();
    for (const turn of rawTurns) {
      for (const steered of turn.steeredEventIds || []) {
        bySteered.set(steered, turn);
      }
      if (turn.nostrEventId) {
        const list = byTrigger.get(turn.nostrEventId) || [];
        list.push(turn);
        byTrigger.set(turn.nostrEventId, list);
      }
      for (const posted of turn.postedEventIds || []) {
        byPosted.set(posted, turn);
      }
    }

    // Build dependency graph
    const parentMap = new Map<AgentTurn, AgentTurn>();
    const edgeTypes = new Map<AgentTurn, ThreadEdgeType>();
    const alternativesMap = new Map<AgentTurn, AgentTurn[]>();
    const childrenMap = new Map<AgentTurn, AgentTurn[]>();
    const inDegree = new Map<AgentTurn, number>();
    const clockSkewAnomalies: Anomaly[] = [];

    for (const turn of rawTurns) {
      inDegree.set(turn, 0);
      childrenMap.set(turn, []);
    }

    for (const turn of rawTurns) {
      const { parent, type, alternatives } = resolveParent(turn, rawTurns, byTrigger, byPosted, bySteered);

      if (parent && parent !== turn && type) {
        parentMap.set(turn, parent);
        edgeTypes.set(turn, type);
        if (alternatives.length > 0) {
          alternativesMap.set(turn, alternatives);
        }
        childrenMap.get(parent)!.push(turn);
        inDegree.set(turn, (inDegree.get(turn) || 0) + 1);

        // Clock skew check: a causal parent should precede its child. Only an exact link is evidence of skew; an
        // inferred one was chosen because it ended before the child started.
        if (type === "REPLY_TO" && parent.startTime && turn.startTime) {
            const parentTime = parent.startTime.getTime();
            const childTime = turn.startTime.getTime();
            const parentEndTime = parent.endTime ? parent.endTime.getTime() : parentTime;

            if (childTime < parentTime) {
              const skewMs = parentTime - childTime;
              clockSkewAnomalies.push({
                type: "CLOCK_SKEW",
                severity: "WARNING",
                message: `Clock skew detected: '${turn.agentName}' replied to '${parent.agentName}', but its start timestamp is earlier by ${skewMs}ms due to container clock drift.`,
                traceId: turn.traceId,
                details: {
                  childAgent: turn.agentName,
                  parentAgent: parent.agentName,
                  skewMs,
                  childStartTime: turn.startTime.toISOString(),
                  parentStartTime: parent.startTime.toISOString(),
                },
              });
            } else if (parent.endTime && childTime < parentEndTime - 100) {
              const overlapMs = parentEndTime - childTime;
              clockSkewAnomalies.push({
                type: "CAUSAL_OVERLAP",
                severity: "WARNING",
                message: `Causal overlap detected: '${turn.agentName}' started ${overlapMs}ms before '${parent.agentName}' finished executing.`,
                traceId: turn.traceId,
                details: {
                  childAgent: turn.agentName,
                  parentAgent: parent.agentName,
                  skewMs: overlapMs,
                  childStartTime: turn.startTime.toISOString(),
                  parentEndTime: parent.endTime.toISOString(),
                },
              });
            }
          }
        }
      }

    // Helper for deterministic tie-breaking (timestamp first, then event/trace ID)
    const compareTurns = (a: AgentTurn, b: AgentTurn): number => {
      const tA = a.startTime ? a.startTime.getTime() : 0;
      const tB = b.startTime ? b.startTime.getTime() : 0;
      if (tA !== tB) {
        return tA - tB;
      }
      const keyA = a.nostrEventId || a.traceId;
      const keyB = b.nostrEventId || b.traceId;
      return keyA.localeCompare(keyB);
    };

    // Topological Sort (Kahn's algorithm with timestamp and identifier tie-breaking)
    const sortedTurns: AgentTurn[] = [];
    const ready: AgentTurn[] = rawTurns.filter((t) => inDegree.get(t) === 0);
    ready.sort(compareTurns);

    while (ready.length > 0) {
      const current = ready.shift()!;
      sortedTurns.push(current);

      const children = childrenMap.get(current) || [];
      for (const child of children) {
        const deg = (inDegree.get(child) || 1) - 1;
        inDegree.set(child, deg);
        if (deg === 0) {
          const insertIdx = ready.findIndex((item) => compareTurns(item, child) > 0);
          if (insertIdx === -1) {
            ready.push(child);
          } else {
            ready.splice(insertIdx, 0, child);
          }
        }
      }
    }

    // Fallback if graph had cycles or disconnected unreached nodes
    if (sortedTurns.length < rawTurns.length) {
      const remaining = rawTurns.filter((t) => !sortedTurns.includes(t));
      remaining.sort(compareTurns);
      sortedTurns.push(...remaining);
    }

    // Assign sequential 1-based turnIndex and tree fields
    for (let i = 0; i < sortedTurns.length; i++) {
      sortedTurns[i].turnIndex = i + 1;
      sortedTurns[i].childrenTurnIndices = [];
    }

    const dagEdges: ThreadDAGEdge[] = [];
    const rootIndices: number[] = [];

    const ambiguityAnomalies: Anomaly[] = [];
    for (const turn of sortedTurns) {
      const parent = parentMap.get(turn);
      if (parent) {
        const type = edgeTypes.get(turn) ?? "REPLY_TO";
        turn.parentTurnIndex = parent.turnIndex;
        turn.parentEdgeType = type;
        turn.depth = (parent.depth ?? 0) + 1;
        parent.childrenTurnIndices = parent.childrenTurnIndices || [];
        parent.childrenTurnIndices.push(turn.turnIndex);
        dagEdges.push({
          fromTurnIndex: parent.turnIndex,
          toTurnIndex: turn.turnIndex,
          type,
        });
        const alternatives = alternativesMap.get(turn) || [];
        if (alternatives.length > 0) {
          turn.parentAlternatives = alternatives.map((a) => a.turnIndex).sort((a, b) => a - b);
          const others = alternatives.map((a) => `Turn ${a.turnIndex} (${a.agentName})`).join(", ");
          ambiguityAnomalies.push({
            type: "AMBIGUOUS_PARENT",
            severity: "INFO",
            message:
              `Turn ${turn.turnIndex} (${turn.agentName}) answers a message no turn is known to have posted; its parent ` +
              `was inferred as Turn ${parent.turnIndex} (${parent.agentName}), but ${others} finished at about the same ` +
              "time. Pass the relay's thread with --messages (or record nostr.posted_event_id in the spans) to make this exact.",
            turnIndex: turn.turnIndex,
            traceId: turn.traceId,
            details: { inferredParent: parent.turnIndex, alternatives: turn.parentAlternatives },
          });
        }
      } else {
        turn.parentTurnIndex = null;
        turn.parentEdgeType = null;
        turn.depth = 0;
        rootIndices.push(turn.turnIndex);
      }
    }

    // Assign branch IDs
    for (const rootIdx of rootIndices) {
      const rootTurn = sortedTurns.find((t) => t.turnIndex === rootIdx);
      if (rootTurn) {
        rootTurn.branchId = rootTurn.branchId || "main";
        this.assignBranches(rootTurn, sortedTurns);
      }
    }

    // Ensure all turns have a branchId (e.g. for cyclic components without roots)
    for (const turn of sortedTurns) {
      if (!turn.branchId) {
        turn.branchId = "main";
      }
    }

    const branchMap = new Map<string, number[]>();
    for (const turn of sortedTurns) {
      const bId = turn.branchId || "main";
      const list = branchMap.get(bId) || [];
      list.push(turn.turnIndex);
      branchMap.set(bId, list);
    }

    const branches: ThreadBranch[] = Array.from(branchMap.entries()).map(([branchId, turnIndices]) => ({
      branchId,
      rootTurnIndex: turnIndices[0],
      turnIndices,
    }));

    const dag: ThreadDAG = {
      rootIndices,
      edges: dagEdges,
      branches,
    };

    // Attach turnIndex to all anomalies
    const allAnomalies = [...clockSkewAnomalies, ...ambiguityAnomalies, ...additionalAnomalies];
    for (const a of allAnomalies) {
      const matchingTurn = sortedTurns.find((t) => t.traceId === a.traceId);
      if (matchingTurn) {
        a.turnIndex = matchingTurn.turnIndex;
        if (a.details) {
          a.details.turnIndex = matchingTurn.turnIndex;
          if (matchingTurn.parentTurnIndex) {
            a.details.parentTurnIndex = matchingTurn.parentTurnIndex;
          }
        }
      }
    }

    return { turns: sortedTurns, dag, anomalies: allAnomalies };
  }

  private assignBranches(current: AgentTurn, allTurns: AgentTurn[], visited = new Set<number>()): void {
    if (visited.has(current.turnIndex)) {
      return;
    }
    visited.add(current.turnIndex);

    const children = (current.childrenTurnIndices || [])
      .map((idx) => allTurns.find((t) => t.turnIndex === idx))
      .filter((t): t is AgentTurn => t !== undefined);

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child.branchId) {
        if (i === 0 && current.branchId) {
          child.branchId = current.branchId;
        } else {
          child.branchId = `branch-turn${current.turnIndex}-${i + 1}`;
        }
      }
      this.assignBranches(child, allTurns, visited);
    }
  }
}
