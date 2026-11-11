/**
 * Dialogue: who said what, in order.
 *
 * It is read from what the transcript's steps recorded, and nothing is inferred:
 *
 * - the message that started a turn, and the messages steered into it, are what people wrote to the agent;
 * - a tool that posts to the thread (a reply) is what the agent wrote back;
 * - in a huddle, the meeting gate gives the agent what people said as the output of `meeting_wait` (`heard[]`, each line with
 *   its speaker, its text and its offset into the call), and takes what the agent says as the input of `meeting_speak`, answering
 *   whether it was spoken to the end or cut off by someone.
 *
 * The gate's wording is read where it is machine-like (`spoken`, "Interrupted by X. Spoken until now: …"); a result that does not
 * match is kept as it is and called `unknown`. A call that failed said nothing, and a steered message the turn ended before
 * receiving was not part of its conversation: neither is listed (the steps view shows both).
 */

import type { Payload, ToolStep, Transcript, TranscriptTurn } from "./transcript.js";

export type SpeechOutcome = "complete" | "interrupted" | "not_spoken" | "async" | "unknown";

export interface DialogueEntry {
  turn: number;
  at: Date | null;
  /** `in`: something the agent received (a message, what a person said); `out`: something the agent said or posted. */
  direction: "in" | "out";
  channel: "meeting" | "thread";
  /** What recorded it: `message`, `steer`, `meeting_wait`, `meeting_speak`, or the posting tool's name. */
  via: string;
  speaker: string;
  text: string;
  /** The gate's offset into the call (`mm:ss`) of something people said. */
  offset: string | null;
  /** Why the gate says it reached the agent (`mention`, `one_on_one`). */
  reason: string | null;
  /** The thread message: the one that started the turn, a steered one, or the one the agent posted when its id is recorded. */
  eventId: string | null;
  /** What became of something the agent said in a call. */
  outcome: SpeechOutcome | null;
  interruptedBy: string | null;
  /** The part of it that was spoken before the cut. */
  spoken: string | null;
  /** The gate's own answer to the call that said it. */
  result: string | null;
}

const INTERRUPTED = /^Interrupted by (.+?)\. Spoken until now: "([\s\S]*)"\s*$/;

/** A tool's name without the namespace a client may put in front of it (`mcp__server__tool`). */
const baseName = (name: string): string => (name.split("__").pop() ?? name).toLowerCase();

const asObject = (payload: Payload | null | undefined): Record<string, unknown> | null =>
  payload?.json !== null && typeof payload?.json === "object" && !Array.isArray(payload.json) ? (payload.json as Record<string, unknown>) : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asObjects = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item)) : [];

const entry = (turn: TranscriptTurn, fields: Partial<DialogueEntry> & Pick<DialogueEntry, "direction" | "channel" | "via" | "speaker" | "text">): DialogueEntry => ({
  turn: turn.turnIndex,
  at: null,
  offset: null,
  reason: null,
  eventId: null,
  outcome: null,
  interruptedBy: null,
  spoken: null,
  result: null,
  ...fields,
});

/** What the gate answered to a `meeting_speak` call, as an outcome. */
function outcomeOf(response: Record<string, unknown> | null): Pick<DialogueEntry, "outcome" | "interruptedBy" | "spoken" | "result"> {
  const result = asString(response?.result);
  const interrupted = result === null ? null : INTERRUPTED.exec(result);
  let outcome: SpeechOutcome = "unknown";
  if (response?.spoken === false) {
    outcome = "not_spoken";
  } else if (interrupted) {
    outcome = "interrupted";
  } else if (result !== null && /asynchronously/i.test(result)) {
    outcome = "async";
  } else if (result !== null && /^finished speaking\.?$/i.test(result.trim())) {
    outcome = "complete";
  }
  return { outcome, interruptedBy: interrupted?.[1] ?? null, spoken: interrupted?.[2] ?? null, result };
}

export function extractDialogue(transcript: Transcript): DialogueEntry[] {
  const entries: DialogueEntry[] = [];
  // The name the agent joined a call with: it speaks under it, in this turn and in a later one that does not join again.
  let joinedAs: string | null = null;

  for (const turn of transcript.turns) {
    const agentName = (): string => joinedAs ?? turn.agent ?? "agent";

    const started = turn.request.message ?? turn.request.prompt?.text ?? null;
    if (started !== null && started.trim() !== "") {
      entries.push(
        entry(turn, { direction: "in", channel: "thread", via: "message", speaker: turn.request.from ?? "unknown sender", text: started, at: turn.startTime, eventId: turn.eventId }),
      );
    }

    for (const step of turn.steps) {
      if (step.type === "steer") {
        if (step.text !== null && step.delivered !== false) {
          entries.push(entry(turn, { direction: "in", channel: "thread", via: "steer", speaker: step.sender ?? "unknown sender", text: step.text, at: step.at, eventId: step.eventId }));
        }
      } else if (step.type === "tool" && step.status === "OK") {
        const call = baseName(step.name);
        if (call === "meeting_join") {
          joinedAs = asString(asObject(step.request)?.display_name)?.trim() || joinedAs;
        } else if (call === "meeting_wait") {
          entries.push(...heardIn(turn, step));
        } else if (call === "meeting_speak") {
          const said = saidIn(turn, step, agentName());
          if (said) {
            entries.push(said);
          }
        } else if (step.posted) {
          const request = asObject(step.request);
          const text = asString(request?.text) ?? asString(request?.content) ?? asString(request?.message);
          if (text !== null && text.trim() !== "") {
            entries.push(entry(turn, { direction: "out", channel: "thread", via: step.name, speaker: agentName(), text, at: step.at, eventId: step.posted.eventId }));
          }
        }
      }
    }
  }
  return entries;
}

/** What people said, as one `meeting_wait` returned it: `heard`, plus any `addressed` line that `heard` lacks. */
function heardIn(turn: TranscriptTurn, step: ToolStep): DialogueEntry[] {
  const response = asObject(step.response);
  const seen = new Set<string>();
  const out: DialogueEntry[] = [];
  for (const line of [...asObjects(response?.heard), ...asObjects(response?.addressed)]) {
    const text = asString(line.text);
    if (text === null || text.trim() === "") {
      continue;
    }
    const speaker = asString(line.speaker) ?? "unknown speaker";
    const offset = asString(line.at);
    const key = `${offset}\u0000${speaker}\u0000${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry(turn, { direction: "in", channel: "meeting", via: "meeting_wait", speaker, text, offset, reason: asString(line.reason), at: step.end ?? step.at }));
  }
  return out;
}

/** What the agent said in a call, and what became of it. */
function saidIn(turn: TranscriptTurn, step: ToolStep, speaker: string): DialogueEntry | null {
  const request = asObject(step.request);
  const text = request ? asString(request.text) : (step.request?.text ?? null);
  if (text === null || text.trim() === "") {
    return null;
  }
  return entry(turn, { direction: "out", channel: "meeting", via: "meeting_speak", speaker, text, at: step.at, ...outcomeOf(asObject(step.response)) });
}
