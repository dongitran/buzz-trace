/**
 * How to say, in a report, how a turn was linked to its parent and what it posted and handled. An exact link (a REPLY_TO
 * edge) needs no qualifier; the others say what the link rests on, so a reader does not take an inferred link for a
 * recorded one, nor a message that was never recorded for one that was.
 */

import { AgentTurn, SteeredMessage } from "../models.js";

/** `212193a2…`: the start of a message id, enough to tell messages of one thread apart. */
export function shortId(id: string | null | undefined): string {
  return id ? `${id.slice(0, 8)}…` : "";
}

/** What the message ids of a report say when no id was recorded. */
export const ID_NOT_RECORDED = "id not recorded";
export const STEERING_NOT_RECORDED = "steered messages are not recorded in this trace";

export function edgeLabel(turn: AgentTurn): string {
  switch (turn.parentEdgeType) {
    case "INFERRED":
      return "inferred";
    case "AMBIGUOUS": {
      const candidates = turn.parentCandidates ?? [];
      return candidates.length > 0 ? `not recorded; ${candidates.map((n) => `Turn ${n}`).join(" or ")}` : "not recorded";
    }
    case "THREAD_ROOT":
      return "thread root";
    case "TEMPORAL":
      return "by time";
    default:
      return "";
  }
}

export function formatCost(usd: number | null | undefined): string | null {
  return usd === null || usd === undefined ? null : `$${usd.toFixed(4)}`;
}

const turnName = (n: number, byIndex: Map<number, AgentTurn>): string => {
  const turn = byIndex.get(n);
  return turn ? `Turn ${n} (${turn.agentName})` : `Turn ${n}`;
};

const orList = (numbers: number[]): string => numbers.map((n) => `Turn ${n}`).join(" or ");

/** The message a turn replies to, and who posted it, or could have: `message 212193a2… posted by Turn 1 (agent)`. Null when it replies to nothing. */
export function describeParent(turn: AgentTurn, turns: AgentTurn[]): string | null {
  const parent = turn.parentMessage;
  if (!parent) {
    return null;
  }
  const byIndex = new Map(turns.map((t) => [t.turnIndex, t]));
  const id = `message ${shortId(parent.id)}`;
  switch (parent.basis) {
    case "posted":
      return `${id} posted by ${turnName(parent.postedByTurn ?? parent.turns[0], byIndex)}`;
    case "annotation":
      return `${id} posted by ${turnName(parent.postedByTurn ?? parent.turns[0], byIndex)} — id from a span annotation`;
    case "started":
      return parent.turns.length === 1
        ? `${id} started ${turnName(parent.turns[0], byIndex)}`
        : `${id} started ${parent.turns.map((n) => `Turn ${n}`).join(" and ")}; linked to ${turnName(turn.parentTurnIndex ?? parent.turns[0], byIndex)}`;
    case "steered":
      return `${id} handled by ${turnName(parent.turns[0], byIndex)}, steered into it`;
    case "inferred":
      return `${id} posted by ${turnName(parent.postedByTurn ?? parent.turns[0], byIndex)} — inferred: the only turn that could have posted it`;
    case "ambiguous":
      return `${id} posted by ${orList(parent.turns)}: not recorded, so no parent is picked`;
    case "thread_root":
      return `${id} (no turn is known to have posted it); linked by the thread root to ${turnName(turn.parentTurnIndex ?? parent.turns[0], byIndex)}`;
    default:
      return `${id} (no turn is known to have posted it)`;
  }
}

/** For a table: who posted the parent message, or `—` when the turn replies to nothing. */
export function describePoster(turn: AgentTurn): string {
  const parent = turn.parentMessage;
  if (!parent) {
    return "—";
  }
  switch (parent.basis) {
    case "posted":
      return `Turn ${parent.postedByTurn ?? parent.turns[0]}`;
    case "annotation":
      return `Turn ${parent.postedByTurn ?? parent.turns[0]} (annotation)`;
    case "inferred":
      return `Turn ${parent.postedByTurn ?? parent.turns[0]} (inferred)`;
    case "ambiguous":
      return `${orList(parent.turns)} (not recorded)`;
    case "started":
      return `started ${parent.turns.map((n) => `Turn ${n}`).join(", ")}`;
    case "steered":
      return `steered into Turn ${parent.turns[0]}`;
    case "thread_root":
      return `no turn known (thread root: Turn ${turn.parentTurnIndex})`;
    default:
      return "no turn known";
  }
}

/** The ids of what a turn posted, short, in order; null when none was recorded. */
export function postedIds(turn: AgentTurn): string[] {
  return (turn.postedEventIds ?? []).map(shortId);
}

/** The steered messages a turn took in, not those it was sent too late (`steer.delivered` false). */
export function deliveredSteers(turn: AgentTurn): SteeredMessage[] {
  return (turn.steered ?? []).filter((m) => m.delivered !== false);
}

/** `1 message`, `4 messages (3 steered)`. */
export function handledLabel(turn: AgentTurn): string {
  const steered = deliveredSteers(turn).length;
  const handled = turn.handledMessages ?? 1 + steered;
  return steered > 0 ? `${handled} messages (${steered} steered)` : `${handled} message${handled === 1 ? "" : "s"}`;
}

/** What a report says of a turn whose steer spans were cut off (the runtime caps them). */
export const STEER_CAPPED_NOTE = "more messages were steered into this turn than the runtime records: this list is not complete";

/** One steered message for a report: its id, priority, text, and, where only a reply call showed it, how it is known. */
export function describeSteered(message: SteeredMessage, maxText = 100): string {
  const id = message.eventId ? shortId(message.eventId) : "(no id recorded)";
  const priority = message.priority ? ` (${message.priority})` : "";
  const flat = message.text ? message.text.replace(/\s+/g, " ").trim() : "";
  const text = flat ? ` "${flat.length > maxText ? `${flat.slice(0, maxText)}...` : flat}"` : "";
  const how =
    message.delivered === false
      ? " — the turn ended before it reached it"
      : message.source === "reply_call"
        ? " (inferred from a reply call; text not recorded)"
        : !flat
          ? " (text not recorded)"
          : "";
  return `${id}${priority}${text}${how}`;
}
