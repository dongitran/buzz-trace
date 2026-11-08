/**
 * Spans shaped like the ones claude-agent-acp's Phoenix telemetry writes for a Buzz thread: one trace per turn, a root
 * `agent_turn` span with the Nostr attributes and a copy of the turn's cost, an `llm:` span with tokens, cache use and
 * cost, and a `tool:` span for the reply the agent posted.
 */
import { ThreadAggregator } from "../../src/engine/aggregator.js";
import { SpanNode } from "../../src/models.js";

export const ROOT = "a".repeat(64);

export interface TurnOptions {
  trace: string;
  agent: string;
  event: string;
  replyTo?: string;
  root?: string;
  start: string;
  end: string;
  text: string;
  cost: number;
  content?: string;
  sender?: string;
}

export function turnSpans(o: TurnOptions): SpanNode[] {
  const root = o.root ?? ROOT;
  return [
    new SpanNode({
      span_id: `${o.trace}-root`,
      trace_id: o.trace,
      parent_id: null,
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: o.start,
      end_time: o.end,
      status_code: "OK",
      attributes: {
        "session.id": root,
        "agent.name": o.agent,
        "nostr.event_id": o.event,
        "nostr.thread_root_id": root,
        "nostr.sender_name": o.sender ?? "Elio Tran",
        ...(o.replyTo ? { "nostr.reply_to_id": o.replyTo } : {}),
        "llm.cost.total": o.cost,
        "input.value": `[Buzz event: @mention]\nEvent ID: ${o.event}\nContent: ${o.content ?? `question to ${o.agent}`}\nTags: []`,
      },
    }),
    new SpanNode({
      span_id: `${o.trace}-llm`,
      trace_id: o.trace,
      parent_id: `${o.trace}-root`,
      name: "llm:sonnet",
      span_kind: "LLM",
      start_time: o.start,
      end_time: o.end,
      status_code: "OK",
      attributes: {
        "llm.model_name": "sonnet",
        "llm.token_count.prompt": 60000,
        "llm.token_count.completion": 200,
        "llm.token_count.total": 60200,
        "llm.token_count.prompt_details.cache_read": 45000,
        "llm.token_count.prompt_details.cache_write": 15000,
        "llm.cost.total": o.cost,
      },
    }),
    new SpanNode({
      span_id: `${o.trace}-reply`,
      trace_id: o.trace,
      parent_id: `${o.trace}-root`,
      name: "tool:mcp__buzz-thread__reply",
      span_kind: "TOOL",
      start_time: o.start,
      end_time: o.end,
      status_code: "OK",
      attributes: {
        "tool.name": "mcp__buzz-thread__reply",
        "tool.parameters.text": o.text,
        "tool.parameters.reply_to": o.event,
      },
    }),
  ];
}

/** Kent answers the thread's root; Ann answers Kent's reply (an event no turn started from), so her parent is inferred. */
export const R2 = "b".repeat(64);
export const AGENT_REPLY = "c".repeat(64);

export function handoffThread(): ReturnType<ThreadAggregator["aggregate"]> {
  const spans = [
    ...turnSpans({ trace: "t1", agent: "kent", event: ROOT, start: "2026-11-08T01:00:00Z", end: "2026-11-08T01:00:10Z", text: "Kent's approach", cost: 0.1 }),
    ...turnSpans({
      trace: "t2",
      agent: "ann",
      event: R2,
      replyTo: AGENT_REPLY,
      start: "2026-11-08T01:00:20Z",
      end: "2026-11-08T01:00:30Z",
      text: "Ann's review",
      cost: 0.05,
    }),
  ];
  return new ThreadAggregator(ROOT, "ba").aggregate(spans);
}
