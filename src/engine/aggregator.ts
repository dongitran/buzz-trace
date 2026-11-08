/**
 * Thread Telemetry Aggregator.
 * Assembles raw OpenTelemetry spans across multiple agent turns into a unified ThreadTelemetry timeline.
 */

import {
  AgentTurn,
  Anomaly,
  type ParentBasis,
  PostRecord,
  type PostedIdSource,
  type SpanAnnotation,
  SpanNode,
  SteeredMessage,
  ThreadBranch,
  ThreadDAG,
  ThreadDAGEdge,
  type ThreadEdgeType,
  ThreadTelemetry,
  ToolExecution,
} from "../models.js";
import {
  POSTED_EVENT_ID_ATTR,
  POSTED_EVENT_IDS_ATTR,
  POSTED_OUTPUT_ATTRS,
  postedIdFromAnnotations,
  postedIdFromOutput,
  STEER_BLOCK_HEADER,
  STEER_CAPPED_EVENT_NAME,
  STEER_DELIVERED_ATTR,
  STEER_END_REASON_ATTR,
  STEER_EVENT_ID_ATTR,
  STEER_EVENT_NAME,
  STEER_PRIORITY_ATTR,
  STEER_SENDER_ATTR,
  STEER_SENDER_PUBKEY_ATTR,
  STEER_SPAN_NAME,
  STEER_TEXT_ATTR,
} from "../contract.js";
import { extractSemanticToolInput } from "../formatters/compact-fmt.js";
import { type BuzzEnvelope, parseBuzzEnvelope } from "./envelope.js";
import { countTokens } from "../tokenizer.js";

const PREVIEW_CHARS = 120;
/** A reply call that started this long after the answering turn did may still have created the message it answers (container clock drift). */
const INFER_SKEW_TOLERANCE_MS = 2000;
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

/** Valid ids (64 hex, lower-cased) out of a value that is one id, a list of ids, or a comma-separated text of them. */
function hexIds(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string") {
      for (const part of v.split(",")) {
        const id = part.trim();
        if (HEX64.test(id)) {
          out.push(id.toLowerCase());
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach(add);
    }
  };
  add(value);
  return out;
}

/** Event ids a span says its turn posted: `nostr.posted_event_id` (one) or `nostr.posted_event_ids` (list or CSV). */
function postedIdsOf(attrs: Record<string, unknown>): string[] {
  return [...hexIds(attrs[POSTED_EVENT_ID_ATTR]), ...hexIds(attrs[POSTED_EVENT_IDS_ATTR])];
}

/** The id of the one message a posting call created, and where it was read. */
interface CreatedId {
  id: string;
  source: PostedIdSource;
}

/**
 * The id of the one message a posting call created: the attribute; else the span's annotation (`annotated`, already read from
 * the span's `nostr.posted_event_id` annotations); else `event_id <hex>` in what the tool returned. An attribute that names
 * several messages decides: the call is not taken for one of them, and no other source is asked.
 */
function createdIdOf(attrs: Record<string, unknown>, annotated: string | null): CreatedId | null {
  const recorded = postedIdsOf(attrs);
  if (recorded.length === 1) {
    return { id: recorded[0], source: "attribute" };
  }
  if (recorded.length > 1) {
    return null;
  }
  if (annotated) {
    return { id: annotated, source: "annotation" };
  }
  for (const name of POSTED_OUTPUT_ATTRS) {
    const id = postedIdFromOutput(attrs[name]);
    if (id) {
      return { id, source: "output" };
    }
  }
  return null;
}

const endMs = (t: AgentTurn) => (t.endTime ? t.endTime.getTime() : t.startTime ? t.startTime.getTime() : 0);
const startMs = (t: AgentTurn) => (t.startTime ? t.startTime.getTime() : 0);

/** Among turns started by the same message, the one a reply most likely continues: the same agent's, else the latest. */
function pickTriggered(options: AgentTurn[], child: AgentTurn): AgentTurn {
  const same = options.filter((t) => t.agentName === child.agentName);
  const pool = same.length > 0 ? same : options;
  return pool.reduce((best, t) => (endMs(t) > endMs(best) ? t : best));
}

/** What buzz-trace found out about the message a turn replies to, before turn numbers exist. */
interface ParentResolution {
  parent?: AgentTurn;
  type: ThreadEdgeType | null;
  basis: ParentBasis;
  /** The turns the basis names (see ParentMessage.turns). */
  turns: AgentTurn[];
  /** The turn that posted the message, when known. */
  postedBy?: AgentTurn;
}

/** Who could have created an unrecorded parent message: the turns whose reply calls fit, once one call = one message is applied. */
interface Unrecorded {
  kind: "inferred" | "ambiguous" | "none";
  turns: AgentTurn[];
}

interface Call {
  turn: AgentTurn;
  post: PostRecord;
}

const sameTrigger = (a: AgentTurn, b: AgentTurn) => a === b || (Boolean(a.nostrEventId) && a.nostrEventId === b.nostrEventId);

/**
 * For every message that turns reply to and no span names (not recorded as posted, not a message that started or was
 * taken into a turn): the turns that could have posted it. A reply call can have created the message when it did not
 * record another id, did not fail, did not answer the message itself, started before every turn that replies to the
 * message did (and not later than the clock-drift tolerance after it), and belongs to a turn that started earlier than
 * those and is neither one of them nor started by the same message. A message that is the thread's root is nobody's reply.
 * One call creates one message, so a call that is the only fit for one message is not a fit for another; if that leaves
 * no consistent answer the plain candidates stand, and two messages that can only be the same call are both left open.
 */
function findUnrecordedPosters(unresolved: Map<string, AgentTurn[]>, turns: AgentTurn[]): Map<string, Unrecorded> {
  if (unresolved.size === 0) {
    return new Map();
  }
  const calls: Call[] = turns.flatMap((turn) => (turn.posts ?? []).filter((p) => p.eventId === null).map((post) => ({ turn, post })));
  const plain = new Map<string, Set<Call>>();
  for (const [messageId, askers] of unresolved) {
    const askedAt = Math.min(...askers.map((a) => (a.startTime ? a.startTime.getTime() : Number.POSITIVE_INFINITY)));
    const set = new Set<Call>();
    for (const call of calls) {
      const earlier = askers.every((a) => !a.startTime || !call.turn.startTime || call.turn.startTime.getTime() < a.startTime.getTime());
      if (
        earlier &&
        !askers.some((a) => sameTrigger(a, call.turn)) &&
        call.post.replyTo !== messageId &&
        !askers.some((a) => a.nostrEventId && call.post.replyTo === a.nostrEventId) &&
        call.post.start <= askedAt + INFER_SKEW_TOLERANCE_MS
      ) {
        set.add(call);
      }
    }
    plain.set(messageId, set);
  }

  // Unit propagation: a message with one possible call takes it, and no other message can have that call.
  const work = new Map([...plain].map(([id, set]) => [id, new Set(set)]));
  const taken = new Set<string>();
  let conflict = false;
  for (let changed = true; changed && !conflict; ) {
    changed = false;
    for (const [id, set] of work) {
      if (taken.has(id) || set.size !== 1) {
        continue;
      }
      taken.add(id);
      const [call] = [...set];
      for (const [other, rest] of work) {
        if (other !== id && rest.delete(call)) {
          changed = true;
          conflict = conflict || rest.size === 0;
        }
      }
    }
  }
  const final = conflict ? plain : work;

  // Two messages that can each only be one and the same call: at least one was not posted by an agent, and which is unknown.
  const soleOwners = new Map<Call, string[]>();
  for (const [id, set] of final) {
    if (set.size === 1) {
      const [call] = [...set];
      soleOwners.set(call, [...(soleOwners.get(call) ?? []), id]);
    }
  }

  const out = new Map<string, Unrecorded>();
  for (const [id, set] of final) {
    const owners = new Set<AgentTurn>([...set].map((c) => c.turn));
    const list = [...owners].sort((a, b) => startMs(a) - startMs(b) || a.traceId.localeCompare(b.traceId));
    const contested = set.size === 1 && (soleOwners.get([...set][0])?.length ?? 0) > 1;
    out.set(id, list.length === 0 ? { kind: "none", turns: [] } : list.length === 1 && !contested ? { kind: "inferred", turns: list } : { kind: "ambiguous", turns: list });
  }
  return out;
}

interface ParentIndexes {
  byTrigger: Map<string, AgentTurn[]>;
  byPosted: Map<string, AgentTurn>;
  bySteered: Map<string, AgentTurn>;
  unrecorded: Map<string, Unrecorded>;
}

/**
 * The turn a turn continues, and how that was found (see ThreadEdgeType). A turn is never the parent of a turn the
 * same message started: those are siblings.
 */
function resolveParent(turn: AgentTurn, idx: ParentIndexes): ParentResolution {
  const isSiblingOrSelf = (t: AgentTurn) => sameTrigger(t, turn);
  const replyTo = turn.nostrReplyTo || null;
  const root = turn.nostrRootId || null;

  // 1. Exact: it answers a message a turn posted (recorded), a message that started other turns, or one a turn took in.
  if (replyTo) {
    const poster = idx.byPosted.get(replyTo);
    if (poster && !isSiblingOrSelf(poster)) {
      const basis = (poster.annotatedEventIds ?? []).includes(replyTo) ? "annotation" : "posted";
      return { parent: poster, type: "REPLY_TO", basis, turns: [poster], postedBy: poster };
    }
    const started = (idx.byTrigger.get(replyTo) || []).filter((t) => !isSiblingOrSelf(t));
    if (started.length > 0) {
      return { parent: pickTriggered(started, turn), type: "REPLY_TO", basis: "started", turns: started };
    }
    // A message steered into a running turn started no turn, but that turn handled it.
    const handler = idx.bySteered.get(replyTo);
    if (handler && !isSiblingOrSelf(handler)) {
      return { parent: handler, type: "REPLY_TO", basis: "steered", turns: [handler] };
    }
  }

  // 2. A message no span names — in a Buzz thread, almost always an agent's own reply. The turns whose reply calls could
  // have created it: one is a deduction (INFERRED), several are listed and none is picked (AMBIGUOUS).
  const inThread = Boolean(root) && root !== turn.nostrEventId;
  if (replyTo && inThread) {
    const found = idx.unrecorded.get(replyTo);
    if (found?.kind === "inferred") {
      return { parent: found.turns[0], type: "INFERRED", basis: "inferred", turns: found.turns, postedBy: found.turns[0] };
    }
    if (found?.kind === "ambiguous") {
      return { type: "AMBIGUOUS", basis: "ambiguous", turns: found.turns };
    }
  }

  // 3. Only the thread's root ties it to a turn.
  if (inThread && root) {
    const started = (idx.byTrigger.get(root) || []).filter((t) => !isSiblingOrSelf(t));
    if (started.length > 0) {
      const parent = pickTriggered(started, turn);
      return { parent, type: "THREAD_ROOT", basis: "thread_root", turns: [parent] };
    }
  }

  return { type: null, basis: "unknown", turns: [] };
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

/** What a posting tool call wrote, which message it answered and, when recorded, which it created; null when the call posts nothing to the thread. */
interface PostCall {
  text: string | null;
  replyTo: string | null;
  eventId: string | null;
  /** Where `eventId` was read; null when there is none. */
  eventIdSource: PostedIdSource | null;
}

const ID_IN_FLAG = /--reply-to\s+(?:"([0-9a-fA-F]{64})"|'([0-9a-fA-F]{64})'|([0-9a-fA-F]{64}))/;

/**
 * A tool that posts to the thread: MCP `…__reply` / `…__send` / `…__post…`, or a shell running `buzz messages send`.
 * `annotations` are those on the tool's span: one of them may give the id of the message the call created (see createdIdOf).
 */
function postOf(toolName: string, attrs: Record<string, unknown>, annotations?: readonly SpanAnnotation[]): PostCall | null {
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
    const created = createdIdOf(attrs, postedIdFromAnnotations(annotations));
    return {
      text: text ? text.trim() : null,
      replyTo: target && HEX64.test(target.trim()) ? target.trim().toLowerCase() : null,
      eventId: created?.id ?? null,
      eventIdSource: created?.source ?? null,
    };
  }
  const command = shellCommandOf(attrs);
  if (command && /\bbuzz\b[^\n]*\bmessages\s+send\b/.test(command)) {
    // A closing quote may be missing: telemetry cuts long inputs and marks the cut with an ellipsis.
    const m = /--content\s+(?:"((?:[^"\\]|\\.)*)(?:"|$)|'([^']*)(?:'|$))/.exec(command);
    const raw = m ? (m[1] !== undefined ? m[1].replace(/\\(["\\$`])/g, "$1") : m[2]) : null;
    const text = raw ? raw.replace(/…$/, "") : null;
    const target = ID_IN_FLAG.exec(command);
    const id = target ? (target[1] ?? target[2] ?? target[3]).toLowerCase() : null;
    const created = createdIdOf(attrs, postedIdFromAnnotations(annotations));
    return { text: text && text.trim() ? text.trim() : null, replyTo: id, eventId: created?.id ?? null, eventIdSource: created?.source ?? null };
  }
  return null;
}

/** A span of a tool call: named `tool:…`, or a tool/internal span that carries `tool.name`. */
function isToolCall(span: SpanNode): boolean {
  return span.name.startsWith("tool:") || ((span.spanKind === "TOOL" || span.spanKind === "SPAN_KIND_INTERNAL") && "tool.name" in span.attributes);
}

const toolNameOf = (span: SpanNode): string => (span.attributes["tool.name"] as string) || span.name.replace(/^tool:/, "");

/**
 * Whether a span may get its posted id from a span annotation: a call of a tool that posts to the thread (see postOf), that did
 * not fail, and whose own attributes record no posted id. An attribute decides, so an annotation could not change what is read
 * for a span that has one; the client asks Phoenix for the annotations of these spans only.
 */
export function wantsPostedId(span: SpanNode): boolean {
  if (span.spanId === "" || !isToolCall(span) || span.statusCode === "ERROR" || postedIdsOf(span.attributes).length > 0) {
    return false;
  }
  return postOf(toolNameOf(span), span.attributes) !== null;
}

/** `true`/`false` from a boolean or from the words; null for anything else. */
function booleanOf(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) {
    return value.trim().toLowerCase() === "true";
  }
  return null;
}

/**
 * One steered message out of the attributes of a `steer` span or event. An id that is not 64 hex is no id. The text of the
 * span is the block the agent was handed (a framing line, the Buzz envelope, a closing note): the message is its `Content:`
 * line. A runtime that records only the message's own text is read as before, minus the framing line if it is there.
 */
function readSteer(attrs: Record<string, unknown>, at: number | null, source: "span" | "event"): SteeredMessage {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const raw = typeof attrs[STEER_TEXT_ATTR] === "string" ? (attrs[STEER_TEXT_ATTR] as string) : "";
  const block = parseBuzzEnvelope(raw);
  const own = raw.trim().startsWith(STEER_BLOCK_HEADER) ? raw.trim().slice(STEER_BLOCK_HEADER.length) : raw;
  // An npub is not a name: the sender is shown by name only when there is one.
  const blockName = block?.senderName && !/^npub1/i.test(block.senderName) ? block.senderName : null;
  return {
    eventId: hexIds(attrs[STEER_EVENT_ID_ATTR])[0] ?? block?.eventId ?? null,
    text: block ? text(block.content) : text(own),
    sender: text(attrs[STEER_SENDER_ATTR]) ?? blockName,
    senderPubkey: hexIds(attrs[STEER_SENDER_PUBKEY_ATTR])[0] ?? block?.senderPubkey ?? null,
    priority: text(attrs[STEER_PRIORITY_ATTR]),
    delivered: booleanOf(attrs[STEER_DELIVERED_ATTR]),
    endReason: text(attrs[STEER_END_REASON_ATTR]),
    at,
    source,
  };
}

export class ThreadAggregator {
  readonly threadId: string;
  /** The project the thread was read from; null when it is not known (it was not named and nothing was found). */
  readonly project: string | null;
  readonly sessionId?: string | null;
  readonly phoenixUiUrl?: string | null;

  constructor(threadId: string, project: string | null = null, sessionId?: string | null, phoenixUiUrl?: string | null) {
    this.threadId = threadId;
    this.project = project;
    this.sessionId = sessionId;
    this.phoenixUiUrl = phoenixUiUrl;
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

    // 1. Group spans by traceId, each trace in the order its spans started (Phoenix may list them newest first).
    const tracesMap = new Map<string, SpanNode[]>();
    for (const span of spans) {
      if (span.traceId) {
        const list = tracesMap.get(span.traceId) || [];
        list.push(span);
        tracesMap.set(span.traceId, list);
      }
    }
    for (const list of tracesMap.values()) {
      const inOrder = list.every((span, i) => i === 0 || !span.startTime || !list[i - 1].startTime || list[i - 1].startTime!.getTime() <= span.startTime.getTime());
      if (!inOrder) {
        list.sort((a, b) => (a.startTime && b.startTime ? a.startTime.getTime() - b.startTime.getTime() : 0));
      }
    }

    // 2. Build AgentTurn for each trace
    const rawTurns: AgentTurn[] = [];
    for (const [traceId, traceSpans] of tracesMap.entries()) {
      rawTurns.push(this.buildTurn(traceId, traceSpans));
    }

    // 2a. The messages each turn handled besides the one that started it (steered into the running turn). Recorded ones
    // come from `steer` spans and events; where nothing recorded them, a reply call that answered another message shows
    // it. The thread's root, the trigger's parent and the triggers of other turns are answers to messages the thread
    // already had a turn for, not steering. A recorded message the turn ended before receiving (`steer.delivered` false) is
    // listed, but it is not known to have been handled: it is not counted and nothing links to it.
    const triggers = new Set(rawTurns.map((t) => t.nostrEventId).filter((id): id is string => Boolean(id)));
    // Whether a turn's runtime is seen to write the contract (steer records, posted ids), so that a steered message would show.
    // An id that only a span annotation records says nothing about the runtime: someone wrote it afterwards.
    const writesContract = (turn: AgentTurn) =>
      Boolean(turn.steerCapped) ||
      (turn.postedEventIds ?? []).some((id) => !(turn.annotatedEventIds ?? []).includes(id)) ||
      turn.spans.some((span) => span.name === STEER_SPAN_NAME || span.events.some((event) => event.name === STEER_EVENT_NAME));
    const agentsWritingContract = new Set(rawTurns.filter(writesContract).map((t) => t.agentName));
    for (const turn of rawTurns) {
      turn.steeringRecorded = writesContract(turn) || agentsWritingContract.has(turn.agentName);
      const recorded = turn.steered ?? [];
      if (recorded.length === 0 && (turn.answeredEventIds ?? []).length === 0) {
        turn.steered = [];
        turn.steeredEventIds = [];
        turn.handledMessages = 1;
        continue;
      }
      const known = new Set(recorded.map((m) => m.eventId).filter((id): id is string => Boolean(id)));
      const inferred = (turn.answeredEventIds ?? []).filter(
        (id) => id !== turn.nostrEventId && id !== turn.nostrRootId && id !== turn.nostrReplyTo && !triggers.has(id) && !known.has(id),
      );
      const steered: SteeredMessage[] = [
        ...recorded,
        ...inferred.map((eventId) => ({
          eventId,
          text: null,
          sender: null,
          senderPubkey: null,
          priority: null,
          delivered: null,
          endReason: null,
          at: null,
          source: "reply_call" as const,
        })),
      ];
      // In the order they arrived; one whose time is not known goes last.
      steered.sort((a, b) => (a.at ?? Number.POSITIVE_INFINITY) - (b.at ?? Number.POSITIVE_INFINITY));
      const handled = steered.filter((m) => m.delivered !== false);
      turn.steered = steered;
      turn.steeredEventIds = handled.map((m) => m.eventId).filter((id): id is string => Boolean(id));
      turn.handledMessages = 1 + handled.length;
    }
    const steeringRecorded = rawTurns.some((t) => t.steeringRecorded);

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
      ((turns.flatMap((t) => t.spans).find((span) => span.attributes["session.id"])?.attributes["session.id"] as string | undefined) ?? null);

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
      steeringRecorded,
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
    // Where each posted id was read. An id a span records is the runtime's, even if an annotation says the same.
    const idSources = new Map<string, PostedIdSource>();
    const noteSource = (id: string, source: PostedIdSource) => {
      const known = idSources.get(id);
      if (known === undefined || (known === "annotation" && source !== "annotation")) {
        idSources.set(id, source);
      }
    };
    const answeredEventIds: string[] = [];
    const posts: PostRecord[] = [];
    const recordedSteers: SteeredMessage[] = [];
    let steerCapped = false;
    const toolWindows: Array<[number, number]> = [];

    for (const span of spans) {
      const attrs = span.attributes;

      // A message steered into the running turn, as the runtime records it: a `steer` event on any span, or a `steer`
      // child span. It is a marker, not a tool, a model call or a prompt.
      for (const event of span.events) {
        if (event.name === STEER_EVENT_NAME) {
          recordedSteers.push(readSteer(event.attributes, event.time ? event.time.getTime() : null, "event"));
        } else if (event.name === STEER_CAPPED_EVENT_NAME) {
          steerCapped = true;
        }
      }
      if (span.name === STEER_SPAN_NAME) {
        recordedSteers.push(readSteer(attrs, span.startTime ? span.startTime.getTime() : null, "span"));
        continue;
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

      const isToolSpan = isToolCall(span);

      // Ids of posted messages a span records. A call that failed created no message, whatever its span says.
      if (!(isToolSpan && span.statusCode === "ERROR")) {
        for (const posted of postedIdsOf(attrs)) {
          noteSource(posted, "attribute");
          if (!postedEventIds.includes(posted)) {
            postedEventIds.push(posted);
          }
        }
      }

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
        const toolName = toolNameOf(span);
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
          const post = postOf(toolName, attrs, span.annotations);
          if (post?.text) {
            postedTexts.push(post.text);
          }
          if (post?.replyTo && !answeredEventIds.includes(post.replyTo)) {
            answeredEventIds.push(post.replyTo);
          }
          if (post?.eventId && post.eventIdSource) {
            noteSource(post.eventId, post.eventIdSource);
            if (!postedEventIds.includes(post.eventId)) {
              postedEventIds.push(post.eventId);
            }
          }
          if (post && span.startTime) {
            posts.push({
              spanId: span.spanId,
              start: span.startTime.getTime(),
              end: (span.endTime ?? span.startTime).getTime(),
              text: post.text,
              replyTo: post.replyTo,
              eventId: post.eventId,
              ...(post.eventIdSource ? { eventIdSource: post.eventIdSource } : {}),
            });
          }
        }
      }
    }

    const modelCalls = countModelCalls(toolWindows);
    const annotatedEventIds = postedEventIds.filter((id) => idSources.get(id) === "annotation");

    // The recorded steered messages: one message once (a span wins over an event), and never the one that started the turn.
    const steered: SteeredMessage[] = [];
    for (const message of recordedSteers) {
      if (message.eventId && message.eventId === nostrEventId) {
        continue;
      }
      const same = message.eventId ? steered.findIndex((m) => m.eventId === message.eventId) : -1;
      if (same === -1) {
        steered.push(message);
      } else if (message.source === "span" && steered[same].source === "event") {
        steered[same] = message;
      }
    }

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
      ...(annotatedEventIds.length > 0 ? { annotatedEventIds } : {}),
      answeredEventIds,
      posts,
      steered,
      steerCapped,
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

    // Index turns by the message that started them (several agents can be started by one message), by the messages
    // they posted (when telemetry records posted event ids) and by the messages they took in while they ran.
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

    // The messages turns reply to that no span names: who could have posted each. A message a `steer` record shows was sent
    // to a turn, not created by one of the turns' reply calls, so it is never looked for among them.
    const steeredAnywhere = new Set(rawTurns.flatMap((t) => (t.steered ?? []).map((m) => m.eventId)).filter((id): id is string => Boolean(id)));
    const unresolved = new Map<string, AgentTurn[]>();
    for (const turn of rawTurns) {
      const replyTo = turn.nostrReplyTo;
      const root = turn.nostrRootId;
      if (!replyTo || !root || root === turn.nostrEventId || replyTo === root || steeredAnywhere.has(replyTo)) {
        continue;
      }
      const poster = byPosted.get(replyTo);
      const named =
        (poster !== undefined && !sameTrigger(poster, turn)) ||
        (byTrigger.get(replyTo) ?? []).some((t) => !sameTrigger(t, turn)) ||
        (bySteered.has(replyTo) && !sameTrigger(bySteered.get(replyTo)!, turn));
      if (!named) {
        unresolved.set(replyTo, [...(unresolved.get(replyTo) ?? []), turn]);
      }
    }
    const indexes: ParentIndexes = { byTrigger, byPosted, bySteered, unrecorded: findUnrecordedPosters(unresolved, rawTurns) };

    // Build dependency graph
    const parentMap = new Map<AgentTurn, AgentTurn>();
    const edgeTypes = new Map<AgentTurn, ThreadEdgeType>();
    const resolutions = new Map<AgentTurn, ParentResolution>();
    const childrenMap = new Map<AgentTurn, AgentTurn[]>();
    const inDegree = new Map<AgentTurn, number>();
    const clockSkewAnomalies: Anomaly[] = [];

    for (const turn of rawTurns) {
      inDegree.set(turn, 0);
      childrenMap.set(turn, []);
    }

    for (const turn of rawTurns) {
      const resolution = resolveParent(turn, indexes);
      resolutions.set(turn, resolution);
      const { parent, type } = resolution;

      if (parent && parent !== turn && type) {
        parentMap.set(turn, parent);
        edgeTypes.set(turn, type);
        childrenMap.get(parent)!.push(turn);
        inDegree.set(turn, (inDegree.get(turn) || 0) + 1);

        // Clock skew check: a causal parent should precede its child. Only an exact link is evidence of skew; an
        // inferred one was chosen because it could have posted before the child started. A turn that replies to a
        // message the parent posted may well start while the parent is still finishing, so it is not an overlap.
        if (type === "REPLY_TO" && parent.startTime && turn.startTime) {
            const knownPost = resolution.basis === "posted" || resolution.basis === "annotation";
            const postedAt = knownPost ? parent.posts?.find((p) => p.eventId === turn.nostrReplyTo)?.start : undefined;
            const parentTime = postedAt ?? parent.startTime.getTime();
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
            } else if (!knownPost && parent.endTime && childTime < parentEndTime - 100) {
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
      const resolution = resolutions.get(turn);
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
      } else {
        turn.parentTurnIndex = null;
        turn.parentEdgeType = resolution?.type === "AMBIGUOUS" ? "AMBIGUOUS" : null;
        turn.depth = 0;
        rootIndices.push(turn.turnIndex);
      }

      // What the message this turn replies to is known to be, in turn numbers.
      if (turn.nostrReplyTo && resolution) {
        const turnsNamed = resolution.turns.map((t) => t.turnIndex).sort((a, b) => a - b);
        turn.parentMessage = {
          id: turn.nostrReplyTo,
          basis: resolution.basis,
          postedByTurn: resolution.postedBy ? resolution.postedBy.turnIndex : null,
          turns: turnsNamed,
        };
        if (resolution.basis === "ambiguous") {
          turn.parentCandidates = turnsNamed;
          const who = resolution.turns
            .slice()
            .sort((a, b) => a.turnIndex - b.turnIndex)
            .map((t) => `Turn ${t.turnIndex} (${t.agentName})`)
            .join(" or ");
          ambiguityAnomalies.push({
            type: "AMBIGUOUS_PARENT",
            severity: "INFO",
            message:
              `Turn ${turn.turnIndex} (${turn.agentName}) replies to message ${turn.nostrReplyTo.slice(0, 8)}…, which no span ` +
              `records as posted. ${who} could have posted it, so no parent is picked. Record nostr.posted_event_id on the ` +
              "reply spans (as an attribute, or afterwards as a span annotation of that name) to make this exact.",
            turnIndex: turn.turnIndex,
            traceId: turn.traceId,
            details: { messageId: turn.nostrReplyTo, candidates: turnsNamed },
          });
        }
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
