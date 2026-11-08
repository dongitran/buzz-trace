/**
 * The telemetry contract: what an agent runtime writes to Phoenix so that buzz-trace can say, exactly, which turn posted a
 * message and which messages a turn handled. Every name lives here and nowhere else.
 *
 * Phoenix is buzz-trace's only source, and what an agent's runtime does not record, Phoenix does not have. Spans written
 * before this contract hold no id for a posted message and no record of a steered one; for those buzz-trace works out what
 * it can and says what it cannot (see README, "What is and is not derivable").
 *
 * 1. Posted messages. The reply tool span (`mcp__buzz-thread__reply`, or any tool that posts) carries the id of the message
 *    it created, as the attribute `nostr.posted_event_id` (64 hex). A runtime that records tool output instead may write
 *    `event_id <64 hex>` in the span's `output.value` or `tool.output`; the reply tool returns
 *    `posted (N characters) · event_id <hex>`.
 *
 * 1b. Annotations, to complete a trace afterwards. A trace written before a runtime recorded the id holds none, and a span
 *    cannot be edited. Phoenix can hold a span annotation, though, and buzz-trace reads one named `nostr.posted_event_id` on a
 *    posting tool span, whose `result.label` is the id (64 hex) of the message the call posted. Whoever knows the ids (say, an
 *    operator who read them from the relay) writes them with `POST /v1/span_annotations`; buzz-trace never writes one.
 *    Where several say, the attribute wins, then the annotation, then `event_id <hex>` in the output text; of several
 *    annotations on one span the latest (`updated_at`) counts, and if its label is no id the span has none from annotations.
 *
 * 2. Steered messages. With `turn_handling: steer`, a message that arrives while a turn runs is injected into that turn and
 *    starts no trace. The runtime records each one as a child span named `steer` under the turn's `agent_turn` span (same
 *    trace), starting when the message was delivered, or as a span event of the same name carrying the same attributes:
 *
 *      name                     steer
 *      openinference.span.kind  CHAIN
 *      nostr.event_id           the steered message's id (64 hex)
 *      input.value              its text (redacted, at most 8 KB)
 *      nostr.sender_name        who wrote it
 *      steer.priority           `now` or `later`
 *
 * A runtime that writes the first (posted ids) is taken to write the second as well: the report prints "steered messages are not
 * recorded in this trace" only for a turn with no sign of either.
 *
 * Example of a reply span: { name: "tool:mcp__buzz-thread__reply", attributes: { "tool.parameters.reply_to": "<id>",
 * "tool.parameters.text": "…", "nostr.posted_event_id": "<id of the message it posted>" } }.
 */

import type { SpanAnnotation } from "./models.js";

/** Attribute on a posting tool span: the id (64 hex) of the message the call created. */
export const POSTED_EVENT_ID_ATTR = "nostr.posted_event_id";
/** Earlier spelling still read: a list (or comma-separated text) of ids, on a tool span or on the turn's root span. */
export const POSTED_EVENT_IDS_ATTR = "nostr.posted_event_ids";
/** Attributes of a posting tool span whose text may carry `event_id <64 hex>`. */
export const POSTED_OUTPUT_ATTRS = ["output.value", "tool.output"] as const;

const POSTED_OUTPUT_PATTERN = /\bevent_id["']?\s*[:=]?\s*["']?([0-9a-f]{64})(?![0-9a-f])/i;

/** The 64-hex id that follows the words `event_id` in a posting tool's output text, lower-cased; null when there is none. */
export function postedIdFromOutput(output: unknown): string | null {
  if (typeof output !== "string") {
    return null;
  }
  const match = POSTED_OUTPUT_PATTERN.exec(output);
  return match ? match[1].toLowerCase() : null;
}

/** Name of the span annotation that gives the id of the message a posting call created: the attribute's own name. */
export const POSTED_EVENT_ID_ANNOTATION = POSTED_EVENT_ID_ATTR;

const HEX64_LABEL = /^[0-9a-f]{64}$/i;

/**
 * The id of the message a posting call created, from the annotations on its span: the label (64 hex, lower-cased) of the latest
 * annotation named `nostr.posted_event_id`. Null when there is none, when the latest one's label is no id (an older one is not
 * used in its place: it was replaced), or when the newest annotations are equally new and name different ids (buzz-trace does not
 * choose). An annotation with no time counts as the oldest.
 */
export function postedIdFromAnnotations(annotations: readonly SpanAnnotation[] | undefined): string | null {
  if (!annotations || annotations.length === 0) {
    return null;
  }
  let newest = Number.NEGATIVE_INFINITY;
  let latest: SpanAnnotation[] = [];
  for (const annotation of annotations) {
    if (annotation.name !== POSTED_EVENT_ID_ANNOTATION) {
      continue;
    }
    const at = annotation.at ?? Number.NEGATIVE_INFINITY;
    if (at > newest) {
      newest = at;
      latest = [annotation];
    } else if (at === newest) {
      latest.push(annotation);
    }
  }
  const labels = new Set(
    latest.map((annotation) => {
      const label = typeof annotation.label === "string" ? annotation.label.trim() : "";
      return HEX64_LABEL.test(label) ? label.toLowerCase() : null;
    }),
  );
  return labels.size === 1 ? [...labels][0] : null;
}

/** Name of the child span, and of the span event, that records a steered message. */
export const STEER_SPAN_NAME = "steer";
export const STEER_EVENT_NAME = "steer";
/** `openinference.span.kind` of a steer span. */
export const STEER_SPAN_KIND = "CHAIN";
export const STEER_EVENT_ID_ATTR = "nostr.event_id";
export const STEER_TEXT_ATTR = "input.value";
export const STEER_SENDER_ATTR = "nostr.sender_name";
export const STEER_PRIORITY_ATTR = "steer.priority";

/**
 * What the Buzz fork also writes on a steer span, beyond the contract. All optional: a runtime that writes none of it is read
 * as before.
 *
 * - `input.value` is the whole block the agent was handed: a framing line, the Buzz envelope (`Event ID:`, `From:`, `Content:`,
 *   `Tags:`, `Parsed:`), and a closing note. buzz-trace takes the `Content:` line as the message's text.
 * - `nostr.sender_pubkey` names the sender; `nostr.sender_name` is there only when the block has a real name.
 * - `steer.delivered` is false when the turn ended before the message was echoed to it or a result named it. The message is not
 *   known to have been handled by that turn (it may run in a later one, or never), so it is listed as not delivered, not counted
 *   and not linked to.
 * - `steer.end_reason` says how the span ended: `echo`, `result` or `turn_end`. `steer.uuid` identifies the injected message.
 */
export const STEER_SENDER_PUBKEY_ATTR = "nostr.sender_pubkey";
export const STEER_DELIVERED_ATTR = "steer.delivered";
export const STEER_END_REASON_ATTR = "steer.end_reason";
export const STEER_UUID_ATTR = "steer.uuid";
/** The first line of the text a steered message arrives in. */
export const STEER_BLOCK_HEADER = "[New message — arrived while you were working]";
/** A span event on the `agent_turn`: the runtime stops writing steer spans after a number of them, so the list is not complete. */
export const STEER_CAPPED_EVENT_NAME = "steer_spans_capped";
