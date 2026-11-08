/**
 * How to say, in a report, how a turn was linked to its parent. An exact link (a REPLY_TO edge) needs no words; the
 * others say what the link rests on, so a reader does not take an inferred link for a recorded one.
 */

import { AgentTurn } from "../models.js";

export function edgeLabel(turn: AgentTurn): string {
  switch (turn.parentEdgeType) {
    case "INFERRED": {
      const others = turn.parentAlternatives ?? [];
      return others.length > 0 ? `inferred; could also be ${others.map((n) => `Turn ${n}`).join(" or ")}` : "inferred";
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
