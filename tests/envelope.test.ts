import { describe, expect, it } from "vitest";
import { parseBuzzEnvelope } from "../src/engine/envelope.js";

const EV = "a".repeat(64);
const ROOT = "b".repeat(64);
const PARENT = "c".repeat(64);
const SENDER = "d".repeat(64);
const CHANNEL = "c06880bc-9779-4615-85f0-b74d61cbdd03";

function envelope(opts: { event?: string; content: string; parsed?: string; tags?: string }): string {
  return [
    "[Buzz event: @mention]",
    `Event ID: ${opts.event ?? EV}`,
    `Channel: consultant (#${CHANNEL})`,
    "Kind: 9",
    `From: Elio Tran (npub: npub1example, hex: ${SENDER})`,
    "Time: 2026-11-08T01:12:10+00:00",
    `Content: ${opts.content}`,
    `Tags: ${opts.tags ?? `[["h","${CHANNEL}"]]`}`,
    opts.parsed ?? "Parsed: mentions=[Paul Twin (eeee)]",
  ].join("\n");
}

describe("parseBuzzEnvelope", () => {
  it("reads the message a person wrote, its sender and its channel from a top-level mention", () => {
    const env = parseBuzzEnvelope(envelope({ content: "@Paul Twin What does SimpleMDG do?" }));
    expect(env).not.toBeNull();
    expect(env?.eventId).toBe(EV);
    expect(env?.content).toBe("@Paul Twin What does SimpleMDG do?");
    expect(env?.senderName).toBe("Elio Tran");
    expect(env?.senderPubkey).toBe(SENDER);
    expect(env?.channelName).toBe("consultant");
    expect(env?.channelId).toBe(CHANNEL);
    expect(env?.parentId).toBeUndefined();
    expect(env?.rootId).toBeUndefined();
  });

  it("reads parent and root of a reply in a thread from the Parsed line", () => {
    const env = parseBuzzEnvelope(
      envelope({ content: "@Paul Twin Next question.", parsed: `Parsed: parent=${PARENT}, root=${ROOT}, mentions=[]` }),
    );
    expect(env?.parentId).toBe(PARENT);
    expect(env?.rootId).toBe(ROOT);
  });

  it("falls back to the NIP-10 root and reply e-tags when there is no Parsed line", () => {
    const tags = `[["h","${CHANNEL}"],["e","${ROOT}","","root"],["e","${PARENT}","","reply"]]`;
    const env = parseBuzzEnvelope(envelope({ content: "hi", tags, parsed: "" }));
    expect(env?.rootId).toBe(ROOT);
    expect(env?.parentId).toBe(PARENT);
  });

  it("keeps a message that spans several lines whole", () => {
    const env = parseBuzzEnvelope(envelope({ content: "First line\nSecond line\n\nThird after a blank" }));
    expect(env?.content).toBe("First line\nSecond line\n\nThird after a blank");
  });

  it("reads the last envelope when several messages were steered into one turn", () => {
    const first = envelope({ event: "1".repeat(64), content: "first message" });
    const second = envelope({ event: "2".repeat(64), content: "second message" });
    const env = parseBuzzEnvelope(`${first}\n\n${second}`);
    expect(env?.eventId).toBe("2".repeat(64));
    expect(env?.content).toBe("second message");
    expect(env?.messages).toBe(2);
  });

  it("returns null for a prompt that is not a Buzz envelope", () => {
    expect(parseBuzzEnvelope("Please summarise the attached file.")).toBeNull();
    expect(parseBuzzEnvelope("")).toBeNull();
  });
});
