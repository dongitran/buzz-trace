/**
 * Phoenix cannot say which message a reply answered when an agent's own reply started no turn: the spans do not record
 * the event id of what a turn posted. The relay's thread does (`buzz messages thread --format json`: id, pubkey,
 * created_at, content, NIP-10 tags). Joining the two on what each reply call answered, when, and what it said makes
 * every link exact. Fixtures follow thread C of the ba run: Paul and Kent answer one message together, then Paul is
 * asked about Kent's answer.
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchThreadTelemetry } from "../src/cli.js";
import { PhoenixClient } from "../src/clients/phoenix-api.js";
import { Config } from "../src/config.js";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { parseThreadMessages } from "../src/engine/messages.js";
import { SpanNode } from "../src/models.js";

const ROOT = "a".repeat(64);
const KENT_REPLY = "b".repeat(64);
const PAUL_REPLY = "c".repeat(64);
const FOLLOW_UP = "d".repeat(64);
const PAUL = "1".repeat(64);
const KENT = "2".repeat(64);
const ME = "3".repeat(64);

const t0 = Date.UTC(2026, 10, 8, 1, 13, 0);
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const epoch = (s: number) => Math.floor((t0 + s * 1000) / 1000);

function turn(o: { trace: string; agent: string; event: string; replyTo?: string; start: number; end: number; post: { text: string; replyTo: string; at: number } }): SpanNode[] {
  return [
    new SpanNode({
      span_id: `${o.trace}-root`,
      trace_id: o.trace,
      parent_id: null,
      name: "agent_turn",
      span_kind: "AGENT",
      start_time: at(o.start),
      end_time: at(o.end),
      status_code: "OK",
      attributes: {
        "session.id": ROOT,
        "agent.name": o.agent,
        "nostr.event_id": o.event,
        "nostr.thread_root_id": ROOT,
        ...(o.replyTo ? { "nostr.reply_to_id": o.replyTo } : {}),
      },
    }),
    new SpanNode({
      span_id: `${o.trace}-reply`,
      trace_id: o.trace,
      parent_id: `${o.trace}-root`,
      name: "tool:mcp__buzz-thread__reply",
      span_kind: "TOOL",
      start_time: at(o.post.at),
      end_time: at(o.post.at + 1),
      status_code: "OK",
      attributes: { "tool.name": "mcp__buzz-thread__reply", "tool.parameters.reply_to": o.post.replyTo, "tool.parameters.text": o.post.text },
    }),
  ];
}

// Paul and Kent are started by the root message; both answer it within a second of each other; then Paul is asked
// something in reply to Kent's answer.
const spans = () => [
  ...turn({ trace: "tk", agent: "kent", event: ROOT, start: 0, end: 7, post: { text: "Kent: walk me through one record", replyTo: ROOT, at: 5 } }),
  ...turn({ trace: "tp", agent: "paul", event: ROOT, start: 0, end: 8, post: { text: "Paul: what business problem do you have?", replyTo: ROOT, at: 5.4 } }),
  ...turn({ trace: "tp2", agent: "paul", event: FOLLOW_UP, replyTo: KENT_REPLY, start: 20, end: 28, post: { text: "Yes, I would keep mine first.", replyTo: FOLLOW_UP, at: 26 } }),
];

const relayThread = () => [
  { id: ROOT, pubkey: ME, created_at: epoch(-1), kind: 9, content: "@Paul Twin @Kent Twin first question?", tags: [["h", "c"], ["p", PAUL], ["p", KENT]] },
  { id: KENT_REPLY, pubkey: KENT, created_at: epoch(5.2), kind: 9, content: "Kent: walk me through one record", tags: [["h", "c"], ["e", ROOT, "", "reply"]] },
  { id: PAUL_REPLY, pubkey: PAUL, created_at: epoch(5.6), kind: 9, content: "Paul: what business problem do you have?", tags: [["h", "c"], ["e", ROOT, "", "reply"]] },
  { id: FOLLOW_UP, pubkey: ME, created_at: epoch(19), kind: 9, content: "@Paul Twin Kent's question differs. Keep yours first?", tags: [["h", "c"], ["e", ROOT, "", "root"], ["e", KENT_REPLY, "", "reply"], ["p", PAUL]] },
  { id: "e".repeat(64), pubkey: PAUL, created_at: epoch(26.4), kind: 9, content: "Yes, I would keep mine first.", tags: [["h", "c"], ["e", ROOT, "", "root"], ["e", FOLLOW_UP, "", "reply"]] },
];

describe("parseThreadMessages", () => {
  it("reads a list or a {messages} wrapper, with author, time, text and the NIP-10 parent and root", () => {
    const [first, second] = parseThreadMessages(relayThread());
    expect(first).toMatchObject({ id: ROOT, pubkey: ME, content: "@Paul Twin @Kent Twin first question?" });
    expect(second).toMatchObject({ id: KENT_REPLY, replyTo: ROOT, createdAt: epoch(5.2) });
    expect(parseThreadMessages({ messages: relayThread() })).toHaveLength(5);
    const follow = parseThreadMessages(relayThread()).find((m) => m.id === FOLLOW_UP);
    expect(follow).toMatchObject({ replyTo: KENT_REPLY, rootId: ROOT });
  });

  it("skips what is not a message, and never throws on junk", () => {
    expect(parseThreadMessages(null)).toEqual([]);
    expect(parseThreadMessages("nope")).toEqual([]);
    expect(parseThreadMessages([{ id: "short" }, 5, null, { id: ROOT, created_at: "x" }])).toEqual([]);
  });
});

describe("joining a turn's reply calls with the relay's messages", () => {
  const aggregate = (messages?: unknown) => new ThreadAggregator(ROOT, "ba").aggregate(spans(), { messages: messages === undefined ? undefined : parseThreadMessages(messages) });

  it("without the relay thread the follow-up's parent is a guess, and says it is ambiguous", () => {
    const t = aggregate();
    const follow = t.turns.find((x) => x.traceId === "tp2")!;
    expect(follow.parentEdgeType).toBe("INFERRED");
    expect(t.anomalies.some((a) => a.type === "AMBIGUOUS_PARENT")).toBe(true);
  });

  it("with it, each turn knows the message it posted, and the follow-up is the exact child of Kent's turn", () => {
    const t = aggregate(relayThread());
    const kent = t.turns.find((x) => x.traceId === "tk")!;
    const paul = t.turns.find((x) => x.traceId === "tp")!;
    const follow = t.turns.find((x) => x.traceId === "tp2")!;
    expect(kent.postedEventIds).toEqual([KENT_REPLY]);
    expect(paul.postedEventIds).toEqual([PAUL_REPLY]);
    expect(follow.parentTurnIndex).toBe(kent.turnIndex);
    expect(follow.parentEdgeType).toBe("REPLY_TO");
    expect(t.anomalies.some((a) => a.type === "AMBIGUOUS_PARENT")).toBe(false);
  });

  it("tells two replies to one message apart by what they said, not only by when", () => {
    // Both calls are within 0.4 s of each other, and the relay lists Paul's message first.
    const swapped = relayThread();
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    const t = aggregate(swapped);
    expect(t.turns.find((x) => x.traceId === "tk")!.postedEventIds).toEqual([KENT_REPLY]);
    expect(t.turns.find((x) => x.traceId === "tp")!.postedEventIds).toEqual([PAUL_REPLY]);
  });

  it("does not link a message that answers something else, or was written far from the call", () => {
    const far = relayThread().map((m) => (m.id === KENT_REPLY ? { ...m, created_at: epoch(300) } : m));
    expect(aggregate(far).turns.find((x) => x.traceId === "tk")!.postedEventIds).toEqual([]);
    const other = relayThread().map((m) => (m.id === KENT_REPLY ? { ...m, tags: [["e", FOLLOW_UP, "", "reply"]] } : m));
    expect(aggregate(other).turns.find((x) => x.traceId === "tk")!.postedEventIds).toEqual([]);
  });

  it("never gives one relay message to two turns", () => {
    const twins = [
      ...turn({ trace: "x1", agent: "a", event: ROOT, start: 0, end: 7, post: { text: "same words", replyTo: ROOT, at: 5 } }),
      ...turn({ trace: "x2", agent: "b", event: ROOT, start: 0, end: 7, post: { text: "same words", replyTo: ROOT, at: 5 } }),
    ];
    const only = [{ id: KENT_REPLY, pubkey: KENT, created_at: epoch(5.1), kind: 9, content: "same words", tags: [["e", ROOT, "", "reply"]] }];
    const t = new ThreadAggregator(ROOT, "ba").aggregate(twins, { messages: parseThreadMessages(only) });
    expect(t.turns.flatMap((x) => x.postedEventIds ?? [])).toEqual([KENT_REPLY]);
  });
});

describe("the CLI path: --messages", () => {
  it("reads the file, links the turns, and says how many messages it read and linked", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-trace-msgs-"));
    const file = path.join(dir, "thread.json");
    fs.writeFileSync(file, JSON.stringify(relayThread()));
    vi.spyOn(PhoenixClient.prototype, "getSpansForThread").mockResolvedValue(spans());
    try {
      const config = new Config({ dbPath: undefined, endpoint: "http://phoenix.test:6006", project: "ba", messagesPath: file });
      const t = await fetchThreadTelemetry(config, ROOT);
      expect(t.turns.find((x) => x.traceId === "tp2")!.parentEdgeType).toBe("REPLY_TO");
      expect(t.source).toBe("http://phoenix.test:6006 + relay messages (5 read, 3 linked)");
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly when the file cannot be read or is not JSON", async () => {
    vi.spyOn(PhoenixClient.prototype, "getSpansForThread").mockResolvedValue(spans());
    try {
      await expect(fetchThreadTelemetry(new Config({ endpoint: "http://x:1", messagesPath: "/no/such/file.json" }), ROOT)).rejects.toThrow(/--messages/);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
