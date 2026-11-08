/** What `inspect --json` and the compact renderer say about a Buzz thread's turns: links, posts, cost and cache. */
import { describe, expect, it } from "vitest";
import { ThreadAggregator } from "../src/engine/aggregator.js";
import { ThreadQueryEngine } from "../src/engine/query.js";
import { JsonRenderer } from "../src/formatters/json-fmt.js";
import { AGENT_REPLY, handoffThread as thread, R2, ROOT } from "./helpers/thread-fixture.js";

describe("thread JSON", () => {
  it("reports each turn's message, sender, how it links up, what it posted, its cost and its cache use", () => {
    const json = thread().toJSON();
    const second = json.turns[1];
    expect(second.event_id).toBe(R2);
    expect(second.reply_to).toBe(AGENT_REPLY);
    expect(second.root_id).toBe(ROOT);
    expect(second.sender).toBe("Elio Tran");
    expect(second.parent_turn_index).toBe(1);
    expect(second.parent_edge).toBe("INFERRED");
    expect(second.posted).toEqual(["Ann's review"]);
    expect(second.cost_usd).toBeCloseTo(0.05, 6);
    expect(second.tokens.cache_read).toBe(45000);
    expect(second.tokens.cache_write).toBe(15000);
    expect(json.turns[0].parent_edge).toBeNull();
  });

  it("totals the thread's cost once, though the root and the LLM span both carry it", () => {
    const json = thread().toJSON();
    expect(json.total_cost_usd).toBeCloseTo(0.15, 6);
  });

  it("keeps compact output short but says which parent was inferred and what each turn posted", () => {
    const compact = JSON.parse(new JsonRenderer().render(thread(), { compact: true, flat: true }));
    expect(compact.turns[1].parent).toBe(1);
    expect(compact.turns[1].edge).toBe("inferred");
    expect(compact.turns[1].response).toBe("Ann's review");
    expect(compact.turns[0].parent).toBeUndefined();
    expect(compact.turns[0].edge).toBeUndefined();
    expect(compact.cost_usd).toBeCloseTo(0.15, 6);
  });
});

describe("what a filter keeps", () => {
  it("keeps the source, and totals the cost of the turns kept", () => {
    const t = thread();
    t.source = "http://phoenix.example:6006";
    const last = new ThreadQueryEngine().filter(t, { lastN: 1 });
    expect(last.source).toBe("http://phoenix.example:6006");
    expect(last.totalCostUsd).toBeCloseTo(0.05, 6);
    const compact = JSON.parse(new JsonRenderer().render(last, { compact: true, flat: true }));
    expect(compact.cost_usd).toBeCloseTo(0.05, 6);
  });

  it("keeps the places that were tried for a thread that was not found", () => {
    const missing = new ThreadAggregator(ROOT, "ba").aggregate([]);
    missing.sourcesTried = ["http://phoenix.example:6006: no spans for it (looked in project ba)"];
    const filtered = new ThreadQueryEngine().filter(missing, {});
    expect(filtered.status).toBe("NOT_FOUND");
    expect(JSON.parse(new JsonRenderer().render(filtered, { compact: true, flat: true })).tried).toEqual(missing.sourcesTried);
  });
});
