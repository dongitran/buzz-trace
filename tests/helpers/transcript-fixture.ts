/**
 * Spans shaped like the ones the Buzz agent runtime writes for a turn that uses tools, as read from a live Phoenix (a Buzz huddle
 * with the meeting gate): a root `agent_turn` span carrying the prompt (`input.value`) and the closing text (`output.value`); one
 * `llm:` span per model call (`llm.iteration`, and the tool calls the model asked for as `llm.output_messages.0.message.tool_calls.N`);
 * one `tool:` span per tool call, with `tool.call_id`, the whole input and output (`input.value`, `output.value`) and the size
 * the tool returned (`tool.output_bytes`).
 *
 * A trace whose process died before the `agent_turn` span ended has every span but that one: `rootless` writes such a trace.
 */
import { SpanNode } from "../../src/models.js";
import { at, HUMAN } from "./phoenix-thread.js";

export const CHANNEL = "c06880bc-9779-4615-85f0-b74d61cbdd03";

export interface FxTool {
  name: string;
  /** Seconds after T0 (see phoenix-thread.ts). */
  at: number;
  dur?: number;
  /** What the runtime recorded as `input.value`: an object is written as JSON, a string as it is. */
  input?: unknown;
  output?: unknown;
  callId?: string;
  /** `tool.output_bytes`; by default the UTF-8 size of the recorded output. */
  bytes?: number;
  status?: "OK" | "ERROR";
  statusMessage?: string;
  isError?: boolean;
  /** Further attributes of the span (for example a recorded `nostr.posted_event_id`). */
  extra?: Record<string, unknown>;
}

/** A message steered into the running turn, recorded as a `steer` child span. */
export interface FxSteer {
  at: number;
  eventId: string;
  text: string;
  sender?: string;
  delivered?: boolean;
}

export interface FxLlm {
  at: number;
  dur?: number;
  iteration?: number;
  /** The tool calls the model asked for. */
  asks?: Array<{ id: string; name: string }>;
  /** Text the model wrote besides (or instead of) tool calls. */
  text?: string;
  prompt?: number;
  completion?: number;
}

export interface FxTurn {
  trace: string;
  /** The thread root: `session.id`. */
  root: string;
  /** The message that started the turn. */
  event: string;
  /** `agent.id` of the root span. */
  agent?: string;
  sender?: string;
  content?: string;
  start: number;
  end: number;
  /** Leave the `agent_turn` span out. */
  rootless?: boolean;
  /** `output.value` of the root span. */
  output?: string;
  llms?: FxLlm[];
  tools?: FxTool[];
  steers?: FxSteer[];
}

const asText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** The prompt a Buzz agent is handed: some framing, then the event envelope. */
export function promptOf(turn: Pick<FxTurn, "event" | "sender" | "content" | "start">): string {
  return [
    "[Agent Memory — core]",
    "No core memory found.",
    "[Context]",
    `Channel: consultant (#${CHANNEL})`,
    "[Buzz event: @mention]",
    `Event ID: ${turn.event}`,
    `Channel: consultant (#${CHANNEL})`,
    "Kind: 9",
    `From: ${turn.sender ?? "Elio Tran"} (npub: npub1x, hex: ${HUMAN})`,
    `Time: ${at(turn.start - 3).slice(0, 19)}+00:00`,
    `Content: ${turn.content ?? "@Kent Twin hello"}`,
    `Tags: ${JSON.stringify([["h", CHANNEL]])}`,
    "Parsed: mentions=[]",
  ].join("\n");
}

export function fxTurnSpans(turn: FxTurn): SpanNode[] {
  const rootId = `${turn.trace}-root`;
  const base = { trace_id: turn.trace, status_code: "OK" };
  const spans: SpanNode[] = [];

  if (!turn.rootless) {
    spans.push(
      new SpanNode({
        ...base,
        span_id: rootId,
        parent_id: null,
        name: "agent_turn",
        span_kind: "AGENT",
        start_time: at(turn.start),
        end_time: at(turn.end),
        attributes: {
          "session.id": turn.root,
          "agent.id": turn.agent ?? "kent-twin",
          "agent.name": `ba-${turn.agent ?? "kent-twin"}`,
          "nostr.event_id": turn.event,
          "nostr.thread_root_id": turn.root,
          "nostr.channel_id": CHANNEL,
          "nostr.sender_name": turn.sender ?? "Elio Tran",
          "input.value": promptOf(turn),
          "input.mime_type": "text/plain",
          ...(turn.output !== undefined ? { "output.value": turn.output, "output.mime_type": "text/plain" } : {}),
        },
      }),
    );
  }

  (turn.llms ?? []).forEach((llm, i) => {
    spans.push(
      new SpanNode({
        ...base,
        span_id: `${turn.trace}-llm${i}`,
        parent_id: rootId,
        name: "llm:deepseek-flash",
        span_kind: "LLM",
        start_time: at(llm.at),
        end_time: at(llm.at + (llm.dur ?? 1)),
        attributes: {
          "session.id": turn.root,
          "llm.model_name": "deepseek-flash",
          "llm.iteration": llm.iteration ?? i + 1,
          "llm.token_count.prompt": llm.prompt ?? 1000,
          "llm.token_count.completion": llm.completion ?? 20,
          "llm.token_count.total": (llm.prompt ?? 1000) + (llm.completion ?? 20),
          "llm.output_messages.0.message.role": "assistant",
          ...(llm.text !== undefined ? { "llm.output_messages.0.message.content": llm.text } : {}),
          ...Object.fromEntries(
            (llm.asks ?? []).flatMap((ask, k) => [
              [`llm.output_messages.0.message.tool_calls.${k}.tool_call.id`, ask.id],
              [`llm.output_messages.0.message.tool_calls.${k}.tool_call.function.name`, ask.name],
            ]),
          ),
          // a model call's input is the whole history so far: the transcript must not repeat it
          "input.value": promptOf(turn),
        },
      }),
    );
  });

  (turn.tools ?? []).forEach((tool, i) => {
    const output = tool.output === undefined ? undefined : asText(tool.output);
    spans.push(
      new SpanNode({
        ...base,
        status_code: tool.status ?? "OK",
        status_message: tool.statusMessage,
        span_id: `${turn.trace}-tool${i}`,
        parent_id: rootId,
        name: `tool:${tool.name}`,
        span_kind: "TOOL",
        start_time: at(tool.at),
        end_time: at(tool.at + (tool.dur ?? 0.5)),
        attributes: {
          "session.id": turn.root,
          "tool.name": tool.name,
          "tool.call_id": tool.callId ?? `call_${turn.trace}_${i}`,
          "tool.is_error": Boolean(tool.isError),
          "tool.output_bytes": tool.bytes ?? (output === undefined ? 0 : Buffer.byteLength(output, "utf8")),
          ...(tool.input !== undefined ? { "input.value": asText(tool.input), "input.mime_type": typeof tool.input === "string" ? "text/plain" : "application/json" } : {}),
          ...(output !== undefined ? { "output.value": output, "output.mime_type": typeof tool.output === "string" ? "text/plain" : "application/json" } : {}),
          ...(tool.extra ?? {}),
        },
      }),
    );
  });

  (turn.steers ?? []).forEach((steer, i) => {
    spans.push(
      new SpanNode({
        ...base,
        span_id: `${turn.trace}-steer${i}`,
        parent_id: rootId,
        name: "steer",
        span_kind: "CHAIN",
        start_time: at(steer.at),
        end_time: at(steer.at),
        attributes: {
          "session.id": turn.root,
          "nostr.event_id": steer.eventId,
          "input.value": steer.text,
          ...(steer.sender ? { "nostr.sender_name": steer.sender } : {}),
          ...(steer.delivered === undefined ? {} : { "steer.delivered": steer.delivered }),
        },
      }),
    );
  });

  return spans;
}
