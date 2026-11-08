/** What a person reads in `inspect` and in the Markdown report of a Buzz thread. */
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "../src/formatters/markdown.js";
import { TerminalRenderer } from "../src/formatters/terminal.js";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { AGENT_REPLY, handoffThread, ROOT, turnSpans } from "./helpers/thread-fixture.js";

describe("terminal report of a Buzz thread", () => {
  const text = new TerminalRenderer(false).render(handoffThread());

  it("shows the thread's cost and what the cache saved", () => {
    expect(text).toContain("Total Cost  : $0.1500");
    expect(text).toContain("Cache       : 90,000 read · 30,000 written");
  });

  it("says who asked, what was asked and what each agent posted", () => {
    expect(text).toContain('From     : Elio Tran');
    expect(text).toContain('Prompt   : "question to ann"');
    expect(text).toContain('Posted   : id not recorded  "Ann\'s review"');
  });

  it("says when a parent was inferred rather than recorded, and why", () => {
    expect(text).toContain(`Reply To : message ${AGENT_REPLY.slice(0, 8)}… posted by Turn 1 (kent) — inferred: the only turn that could have posted it`);
  });

  it("lists the turns that could have posted a parent nobody recorded, and picks none", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 1, 0, s)).toISOString();
    const spans = [
      ...turnSpans({ trace: "p", agent: "paul", event: ROOT, start: at(0), end: at(8), text: "p", cost: 0.1 }),
      ...turnSpans({ trace: "k", agent: "kent", event: ROOT, start: at(0), end: at(7), text: "k", cost: 0.1 }),
      ...turnSpans({ trace: "p2", agent: "paul", event: "e".repeat(64), replyTo: "9".repeat(64), start: at(20), end: at(26), text: "p2", cost: 0.1 }),
    ];
    const out = new TerminalRenderer(false).render(new ThreadAggregator(ROOT, "ba").aggregate(spans));
    expect(out).toContain(`Reply To : message ${"9".repeat(8)}… posted by Turn 1 or Turn 2: not recorded, so no parent is picked`);
  });
});

describe("Markdown report of a Buzz thread", () => {
  const md = new MarkdownRenderer().render(handoffThread());

  it("adds cost to the overview and parent, edge and cost to the timeline", () => {
    expect(md).toContain("| **Total Cost** | `$0.1500` |");
    expect(md).toContain("| Turn | Agent | Parent | Model | Status | Latency | Tokens | Cost | Tools | Trace ID |");
    expect(md).toMatch(/\| \*\*2\*\* \| `ann` \| 1 \(inferred\) \|/);
    expect(md).toMatch(/\| \*\*1\*\* \| `kent` \| — \|/);
  });

  it("draws an inferred edge dashed, so the diagram does not claim more than the data shows", () => {
    expect(md).toContain('T1["Turn 1: kent"] -. inferred .-> T2["Turn 2: ann"]');
  });

  it("numbers its sections one after another, with or without anomalies", () => {
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings.map((h) => Number(h.slice(3).split(".")[0]))).toEqual(headings.map((_, i) => i + 1));
  });

  it("lists what each turn posted", () => {
    expect(md).toContain("## 5. What the agents posted");
    expect(md).toContain("**Turn 2 · ann:** Ann's review");
  });
});

describe("where the data came from", () => {
  it("terminal and Markdown name the source of a found thread", () => {
    const thread = handoffThread();
    thread.source = "http://phoenix.example:6006";
    expect(new TerminalRenderer(false).render(thread)).toContain("Source      : http://phoenix.example:6006");
    expect(new MarkdownRenderer().render(thread)).toContain("| **Source** | `http://phoenix.example:6006` |");
  });

  it("terminal lists every place it looked when a thread is not found", () => {
    const missing = new ThreadAggregator(ROOT, "ba").aggregate([]);
    missing.sourcesTried = ["http://phoenix.example:6006: no spans for it (looked in projects ba, mobile)", "http://localhost:6006: no spans for it"];
    const out = new TerminalRenderer(false).render(missing);
    expect(out).toContain("NOT_FOUND");
    expect(out).toContain("Looked in:");
    expect(out).toContain("http://phoenix.example:6006: no spans for it (looked in projects ba, mobile)");
    expect(out).toContain("http://localhost:6006: no spans for it");
  });
});
