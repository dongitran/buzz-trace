/**
 * Reader for the Buzz event envelope that buzz-acp hands an agent as its prompt:
 *
 *   [Buzz event: @mention]
 *   Event ID: <64 hex>
 *   Channel: <name> (#<uuid>)
 *   From: <name> (npub: …, hex: <64 hex>)
 *   Content: <what the person wrote, possibly several lines>
 *   Tags: [["h", …], ["e", <root>, "", "root"], ["e", <parent>, "", "reply"], …]
 *   Parsed: parent=<64 hex>, root=<64 hex>, mentions=[…]
 *
 * Several messages steered into one running turn arrive as several envelopes; the last one is the turn's own.
 */

export interface BuzzEnvelope {
  eventId?: string;
  channelName?: string;
  channelId?: string;
  senderName?: string;
  senderPubkey?: string;
  /** What the person wrote: the Content field, whole. */
  content?: string;
  /** The event this message replies to (NIP-10 "reply"). */
  parentId?: string;
  /** The thread's root event (NIP-10 "root"). */
  rootId?: string;
  /** How many envelopes the prompt held (more than 1 when messages were steered into one turn). */
  messages: number;
}

const HEX64 = "[0-9a-fA-F]{64}";
const ENVELOPE_START = /^\[Buzz event[^\]]*\]\s*$/gm;
const FIELD = /^(Event ID|Channel|Kind|From|Time|Content|Tags|Parsed):\s?/;

export function parseBuzzEnvelope(text: string | null | undefined): BuzzEnvelope | null {
  if (!text || !/Event ID:\s*[0-9a-fA-F]{64}/.test(text)) {
    return null;
  }

  // Isolate the last envelope: from the last "[Buzz event …]" header, else from the last "Event ID:" line.
  const starts = [...text.matchAll(ENVELOPE_START)].map((m) => m.index ?? 0);
  let body = text;
  if (starts.length > 0) {
    body = text.slice(starts[starts.length - 1]);
  } else {
    const lastEvent = text.lastIndexOf("Event ID:");
    body = text.slice(lastEvent);
  }
  const messages = Math.max(starts.length, (text.match(/^Event ID:/gm) || []).length, 1);

  const env: BuzzEnvelope = { messages };
  const lines = body.split("\n");
  let contentLines: string[] | null = null;
  for (const line of lines) {
    const field = FIELD.exec(line);
    if (field) {
      if (contentLines && field[1] !== "Content") {
        env.content = contentLines.join("\n").trim();
        contentLines = null;
      }
      const value = line.slice(field[0].length).trim();
      switch (field[1]) {
        case "Event ID": {
          const m = new RegExp(`^(${HEX64})`).exec(value);
          if (m) {env.eventId = m[1].toLowerCase();}
          break;
        }
        case "Channel": {
          const m = /^(.*?)\s*\(#([0-9a-fA-F-]{36})\)\s*$/.exec(value);
          if (m) {
            if (m[1]) {env.channelName = m[1];}
            env.channelId = m[2].toLowerCase();
          } else if (value) {
            env.channelName = value;
          }
          break;
        }
        case "From": {
          const m = new RegExp(`^(.*?)\\s*\\((?:[^)]*?hex:\\s*(${HEX64}))[^)]*\\)\\s*$`).exec(value);
          if (m) {
            env.senderName = m[1].trim();
            env.senderPubkey = m[2].toLowerCase();
          } else if (value) {
            env.senderName = value;
          }
          break;
        }
        case "Content":
          contentLines = [value];
          break;
        case "Tags":
          readTags(value, env);
          break;
        case "Parsed": {
          const parent = new RegExp(`\\bparent=(${HEX64})\\b`).exec(value);
          const root = new RegExp(`\\broot=(${HEX64})\\b`).exec(value);
          if (parent) {env.parentId = parent[1].toLowerCase();}
          if (root) {env.rootId = root[1].toLowerCase();}
          break;
        }
      }
    } else if (contentLines) {
      contentLines.push(line);
    }
  }
  if (contentLines) {
    env.content = contentLines.join("\n").trim();
  }
  return env;
}

function readTags(value: string, env: BuzzEnvelope): void {
  let tags: unknown;
  try {
    tags = JSON.parse(value);
  } catch {
    return;
  }
  if (!Array.isArray(tags)) {return;}
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== "e" || typeof tag[1] !== "string" || !new RegExp(`^${HEX64}$`).test(tag[1])) {
      continue;
    }
    const id = tag[1].toLowerCase();
    if (tag[3] === "root" && !env.rootId) {env.rootId = id;}
    if (tag[3] === "reply" && !env.parentId) {env.parentId = id;}
  }
}
