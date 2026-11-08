/**
 * Spans shaped like the ones an agent runtime's Phoenix telemetry writes for a Buzz thread, as Phoenix's REST API returns
 * them: one trace per agent turn; a root `agent_turn` span carrying `nostr.event_id` (the message that started the turn),
 * `nostr.reply_to_id`, `nostr.thread_root_id` and the envelope as `input.value`; an `llm:` span; one `tool:` span per tool
 * call, where the reply tool records `tool.parameters.reply_to` / `.text` and only the size of what it returned
 * (`tool.output_bytes`), never the id of the message it posted.
 *
 * Ids are synthetic 64-hex strings made from a label, so a test can say `hex("kent-reply")`.
 */
import { createHash } from "node:crypto";
import { SpanNode } from "../../src/models.js";

export const hex = (label: string): string => createHash("sha256").update(label).digest("hex");

/** 2026-11-08 04:46:12 UTC: the first second of the real thread the fixtures follow. */
export const T0 = Date.UTC(2026, 10, 8, 4, 46, 12);
export const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const CHANNEL = "c06880bc-9779-4615-85f0-b74d61cbdd03";
export const HUMAN = hex("human-pubkey");

export interface PostSpec {
  /** The message the call answers (`tool.parameters.reply_to`). */
  replyTo: string;
  text: string;
  /** Seconds after T0 that the call starts. */
  at: number;
  dur?: number;
  /** The id of the message the call created, as a producer that follows the contract records it. */
  eventId?: string;
  /** What the tool returned, as a producer that records tool output writes it. */
  output?: string;
  outputAttr?: "output.value" | "tool.output";
  error?: boolean;
  tool?: string;
}

export interface SteerSpec {
  eventId: string;
  text: string;
  /** Seconds after T0 that the message was injected into the running turn. */
  at: number;
  sender?: string;
  priority?: string;
  /** Recorded as a child span (the contract) or as a span event on the turn's root span. */
  as?: "span" | "event";
  /** What the Buzz fork also writes: `steer.delivered` (a boolean, or the words), `steer.end_reason`, `nostr.sender_pubkey`. */
  delivered?: boolean | string;
  endReason?: string;
  senderPubkey?: string;
  /** Leave `nostr.event_id` out, as a record that names no message would. */
  noEventId?: boolean;
}

/**
 * The block a steered message arrives in, as the Buzz fork records it in `input.value`: a framing line, the envelope, and a
 * closing note. `from` is what the envelope's From line says (the fork's blocks have an npub and no name).
 */
export function steerBlock(o: { eventId: string; content: string; root: string; from?: string; pubkey?: string }): string {
  return [
    "[New message — arrived while you were working]",
    "",
    "[Buzz event: @mention]",
    `Event ID: ${o.eventId}`,
    `Channel: ${CHANNEL}`,
    "Kind: 9",
    `From: ${o.from ?? "npub1lt6z6e95lgsr8dfc27hjemj2z4hrh22d96j0lvu7hj2j2pdexlksyt0uu7"} (hex: ${o.pubkey ?? HUMAN})`,
    "Time: 2026-11-08T06:41:18+00:00",
    `Content: ${o.content}`,
    `Tags: ${JSON.stringify([["h", CHANNEL], ["e", o.root, "", "reply"], ["p", hex("paul-pubkey")]])}`,
    `Parsed: parent=${o.root}, root=${o.root}, mentions=[${hex("paul-pubkey")}]`,
    "",
    "Note: A new message arrived while you were working. Continue your in-progress work and incorporate the new message if it's relevant; if it's unrelated, you may briefly acknowledge it and carry on.",
  ].join("\n");
}

export interface ToolSpec {
  name: string;
  at: number;
  dur?: number;
  params?: Record<string, unknown>;
  output?: string;
}

export interface TurnSpec {
  trace: string;
  agent: string;
  /** The message that started the turn. */
  event: string;
  replyTo?: string;
  root: string;
  /** Seconds after T0. */
  start: number;
  end: number;
  content?: string;
  sender?: string;
  posts?: PostSpec[];
  steers?: SteerSpec[];
  tools?: ToolSpec[];
  /** Extra attributes on the root span (for example a recorded `nostr.posted_event_id`). */
  rootAttributes?: Record<string, unknown>;
  /** The runtime stopped writing steer spans for this turn: a `steer_spans_capped` event on its root span. */
  steerCapped?: boolean;
}

function steerAttributes(s: SteerSpec): Record<string, unknown> {
  return {
    ...(s.noEventId ? {} : { "nostr.event_id": s.eventId }),
    "input.value": s.text,
    ...(s.sender ? { "nostr.sender_name": s.sender } : {}),
    ...(s.senderPubkey ? { "nostr.sender_pubkey": s.senderPubkey } : {}),
    ...(s.priority ? { "steer.priority": s.priority } : {}),
    ...(s.delivered !== undefined ? { "steer.delivered": s.delivered } : {}),
    ...(s.endReason ? { "steer.end_reason": s.endReason } : {}),
  };
}

function envelope(spec: TurnSpec): string {
  const tags = [["h", CHANNEL], ...(spec.replyTo ? [["e", spec.root, "", "root"], ["e", spec.replyTo, "", "reply"]] : [])];
  return [
    "[Buzz event: @mention]",
    `Event ID: ${spec.event}`,
    `Channel: consultant (#${CHANNEL})`,
    "Kind: 9",
    `From: ${spec.sender ?? "Elio Tran"} (npub: npub1x, hex: ${HUMAN})`,
    `Time: ${new Date(T0 + (spec.start - 3) * 1000).toISOString().slice(0, 19)}+00:00`,
    `Content: ${spec.content ?? `question for ${spec.agent}`}`,
    `Tags: ${JSON.stringify(tags)}`,
    spec.replyTo ? `Parsed: parent=${spec.replyTo}, root=${spec.root}, mentions=[]` : "Parsed: mentions=[]",
  ].join("\n");
}

export function turnSpans(spec: TurnSpec): SpanNode[] {
  const rootId = `${spec.trace}-root`;
  const base = { trace_id: spec.trace, status_code: "OK" };
  const steerEvents = (spec.steers ?? [])
    .filter((s) => s.as === "event")
    .map((s) => ({
      name: "steer",
      timestamp: at(s.at),
      attributes: steerAttributes(s),
    }));
  const spans: SpanNode[] = [
    new SpanNode({
      ...base,
      span_id: rootId,
      parent_id: null,
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: at(spec.start),
      end_time: at(spec.end),
      attributes: {
        "session.id": spec.root,
        "user.id": HUMAN,
        "agent.name": spec.agent,
        "input.value": envelope(spec),
        "input.mime_type": "text/plain",
        "output.value": `I posted my answer (${spec.agent}).`,
        "nostr.event_id": spec.event,
        "nostr.thread_root_id": spec.root,
        "nostr.channel_id": CHANNEL,
        "nostr.sender_name": spec.sender ?? "Elio Tran",
        ...(spec.replyTo ? { "nostr.reply_to_id": spec.replyTo } : {}),
        "llm.token_count.prompt": 40000,
        "llm.token_count.completion": 300,
        "llm.token_count.total": 40300,
        "llm.cost.total": 0.015,
        ...(spec.rootAttributes ?? {}),
      },
      events: [...steerEvents, ...(spec.steerCapped ? [{ name: "steer_spans_capped", timestamp: at(spec.end), attributes: {} }] : [])],
    }),
    new SpanNode({
      ...base,
      span_id: `${spec.trace}-llm`,
      parent_id: rootId,
      name: "llm:sonnet",
      span_kind: "LLM",
      start_time: at(spec.start),
      end_time: at(spec.end),
      attributes: {
        "session.id": spec.root,
        "llm.model_name": "sonnet",
        "llm.token_count.prompt": 40000,
        "llm.token_count.completion": 300,
        "llm.token_count.total": 40300,
        "input.value": envelope(spec),
      },
    }),
  ];

  (spec.tools ?? []).forEach((tool, i) => {
    spans.push(
      new SpanNode({
        ...base,
        span_id: `${spec.trace}-tool${i}`,
        parent_id: rootId,
        name: `tool:${tool.name}`,
        span_kind: "TOOL",
        start_time: at(tool.at),
        end_time: at(tool.at + (tool.dur ?? 0.8)),
        attributes: {
          "session.id": spec.root,
          "tool.name": tool.name,
          "tool.output_bytes": tool.output?.length ?? 100,
          "input.value": JSON.stringify(tool.params ?? {}),
          ...Object.fromEntries(Object.entries(tool.params ?? {}).map(([k, v]) => [`tool.parameters.${k}`, v])),
          ...(tool.output !== undefined ? { "output.value": tool.output } : {}),
        },
      }),
    );
  });

  (spec.posts ?? []).forEach((post, i) => {
    const name = post.tool ?? "mcp__buzz-thread__reply";
    spans.push(
      new SpanNode({
        ...base,
        status_code: post.error ? "ERROR" : "OK",
        span_id: `${spec.trace}-post${i}`,
        parent_id: rootId,
        name: `tool:${name}`,
        span_kind: "TOOL",
        start_time: at(post.at),
        end_time: at(post.at + (post.dur ?? 1.3)),
        attributes: {
          "session.id": spec.root,
          "tool.name": name,
          "tool.is_error": Boolean(post.error),
          "tool.output_bytes": 50,
          "input.value": JSON.stringify({ reply_to: post.replyTo, text: post.text }),
          "tool.parameters.reply_to": post.replyTo,
          "tool.parameters.text": post.text,
          ...(post.eventId ? { "nostr.posted_event_id": post.eventId } : {}),
          ...(post.output !== undefined ? { [post.outputAttr ?? "output.value"]: post.output } : {}),
        },
      }),
    );
  });

  (spec.steers ?? [])
    .filter((s) => s.as !== "event")
    .forEach((s, i) => {
      spans.push(
        new SpanNode({
          ...base,
          status_code: s.delivered === false || s.delivered === "false" ? "UNSET" : "OK",
          span_id: `${spec.trace}-steer${i}`,
          parent_id: rootId,
          name: "steer",
          span_kind: "CHAIN",
          start_time: at(s.at),
          end_time: at(s.at),
          attributes: { "session.id": spec.root, "openinference.span.kind": "CHAIN", ...steerAttributes(s) },
        }),
      );
    });

  return spans;
}

/**
 * The thread the owner checked (project `ba`): Kent Twin and Paul Twin are both started by the root message and answer it
 * about a second apart; the person then replies to KENT's message (an id no span records) asking Paul. Ground truth from
 * the relay: that message was posted by turn 1 (Kent), not by turn 2.
 */
export const THREAD_C = {
  root: hex("c-root"),
  kentMessage: hex("c-kent-message"),
  paulMessage: hex("c-paul-message"),
  followUp: hex("c-follow-up"),
};

export function threadC(options: { kentId?: boolean; paulId?: boolean } = {}): SpanNode[] {
  const { root, kentMessage, paulMessage, followUp } = THREAD_C;
  return [
    ...turnSpans({
      trace: "t1-kent",
      agent: "ba-kent-twin",
      event: root,
      root,
      start: 0,
      end: 6.4,
      content: "@Paul Twin @Kent Twin one sentence each: the first question you ask a client?",
      posts: [{ replyTo: root, text: "Kent Twin here. My first question: what business problem costs you the most today?", at: 3.3, eventId: options.kentId ? kentMessage : undefined }],
    }),
    ...turnSpans({
      trace: "t2-paul",
      agent: "ba-paul-twin",
      event: root,
      root,
      start: 0.9,
      end: 7.3,
      content: "@Paul Twin @Kent Twin one sentence each: the first question you ask a client?",
      posts: [{ replyTo: root, text: "Paul Twin: which master data domain are you solving first, and who feels the pain?", at: 4.1, eventId: options.paulId ? paulMessage : undefined }],
    }),
    ...turnSpans({
      trace: "t3-paul",
      agent: "ba-paul-twin",
      event: followUp,
      replyTo: kentMessage,
      root,
      start: 10.8,
      end: 18.7,
      content: "@Paul Twin Kent's first question is different from yours. Would you keep yours first?",
      tools: [{ name: "mcp__buzz-thread__thread_read", at: 13, params: { root_event_id: root }, output: undefined }],
      posts: [{ replyTo: followUp, text: "Yes, I would keep mine first.", at: 15.9 }],
    }),
  ];
}
