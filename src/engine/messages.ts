/**
 * The relay's side of a thread: `buzz messages thread --format json` lists every message with its author, time, text and
 * NIP-10 tags. Phoenix spans do not record the event id of what a turn posted, so which message a later reply answered
 * can only be guessed from the spans. Joined with this list the guess becomes exact: each reply call of a turn is matched to
 * the relay message it created (same message answered, same moment, same words), and `postedEventIds` fills in.
 */

import { AgentTurn } from "../models.js";

export interface ThreadMessage {
  id: string;
  pubkey: string;
  /** Unix seconds, as the relay stores it. */
  createdAt: number;
  content: string;
  kind?: number;
  /** The message this one replies to (NIP-10 "reply" e-tag). */
  replyTo?: string;
  /** The thread's root (NIP-10 "root" e-tag). */
  rootId?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
/** A reply call and the message it created are seconds apart at most: the call signs the message when it runs. */
const WINDOW_MS = 2000;
const TEXT_PREFIX = 60;

/** A list of messages, or an object holding one under `messages`; anything unreadable is skipped, never thrown on. */
export function parseThreadMessages(raw: unknown): ThreadMessage[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { messages?: unknown }).messages)
      ? (raw as { messages: unknown[] }).messages
      : [];
  const out: ThreadMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const m = item as Record<string, unknown>;
    if (typeof m.id !== "string" || !HEX64.test(m.id) || typeof m.created_at !== "number" || !Number.isFinite(m.created_at)) {
      continue;
    }
    const message: ThreadMessage = {
      id: m.id.toLowerCase(),
      pubkey: typeof m.pubkey === "string" ? m.pubkey.toLowerCase() : "",
      createdAt: m.created_at,
      content: typeof m.content === "string" ? m.content : "",
    };
    if (typeof m.kind === "number") {
      message.kind = m.kind;
    }
    readParents(m.tags, message);
    out.push(message);
  }
  return out;
}

/** NIP-10: marked e-tags first; without markers one e-tag is the reply, two are root then reply. */
function readParents(tags: unknown, message: ThreadMessage): void {
  if (!Array.isArray(tags)) {
    return;
  }
  const events = tags
    .filter((t): t is string[] => Array.isArray(t) && t[0] === "e" && typeof t[1] === "string" && HEX64.test(t[1]))
    .map((t) => ({ id: t[1].toLowerCase(), marker: typeof t[3] === "string" ? t[3] : "" }));
  const root = events.find((e) => e.marker === "root");
  const reply = events.find((e) => e.marker === "reply");
  if (root || reply) {
    if (root) {
      message.rootId = root.id;
    }
    message.replyTo = (reply ?? root)?.id;
    return;
  }
  if (events.length === 1) {
    message.replyTo = events[0].id;
  } else if (events.length >= 2) {
    message.rootId = events[0].id;
    message.replyTo = events[events.length - 1].id;
  }
}

/** The text a reply call was given and the text it posted differ in what the tool cleans (`@` becomes `(at)`, spacing). */
function normalize(text: string): string {
  return text.replace(/@/g, "(at)").replace(/\s+/g, " ").trim().toLowerCase();
}

function sameWords(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x.length < 8 || y.length < 8) {
    return x === y && x.length > 0;
  }
  return x.startsWith(y.slice(0, TEXT_PREFIX)) || y.startsWith(x.slice(0, TEXT_PREFIX));
}

/**
 * Fills in `postedEventIds` of each turn from its reply calls. A message is given to one call only. Returns how many
 * calls were matched.
 */
export function linkPostedMessages(turns: AgentTurn[], messages: ThreadMessage[]): number {
  const claimed = new Set<string>();
  let linked = 0;
  type Call = { turn: AgentTurn; start: number; end: number; text: string | null; replyTo: string | null };
  const calls: Call[] = turns
    .flatMap((turn) => (turn.posts ?? []).map((p) => ({ turn, start: p.start, end: p.end, text: p.text, replyTo: p.replyTo })))
    .sort((a, b) => a.end - b.end);

  const near = (call: Call, m: ThreadMessage) =>
    !claimed.has(m.id) &&
    m.createdAt * 1000 + 999 >= call.start - WINDOW_MS &&
    m.createdAt * 1000 <= call.end + WINDOW_MS &&
    (call.replyTo === null || m.replyTo === call.replyTo);
  const take = (call: Call, m: ThreadMessage) => {
    claimed.add(m.id);
    call.turn.postedEventIds = call.turn.postedEventIds ?? [];
    if (!call.turn.postedEventIds.includes(m.id)) {
      call.turn.postedEventIds.push(m.id);
    }
    linked += 1;
  };

  // Pass 1: the calls whose words match a message answering the same message at the same moment; closest in time wins.
  const open: Call[] = [];
  for (const call of calls) {
    const middle = (call.start + call.end) / 2;
    const strong = call.text ? messages.filter((m) => near(call, m) && sameWords(call.text as string, m.content)) : [];
    if (strong.length > 0) {
      strong.sort((a, b) => Math.abs(a.createdAt * 1000 - middle) - Math.abs(b.createdAt * 1000 - middle));
      take(call, strong[0]);
    } else {
      open.push(call);
    }
  }

  // Pass 2: a call left over with exactly one candidate that no other left-over call could also be, by elimination.
  for (const call of open) {
    const mine = messages.filter((m) => near(call, m));
    if (mine.length === 1 && open.filter((other) => other !== call && near(other, mine[0])).length === 0) {
      take(call, mine[0]);
    }
  }
  return linked;
}
