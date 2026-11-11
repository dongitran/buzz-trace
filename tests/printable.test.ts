/**
 * A transcript prints what tools and web pages returned, whole. Text like that can hold escape sequences that move the cursor,
 * clear the screen or set the window title of whoever reads it. In a terminal and in a report they must be seen, not obeyed.
 */
import { describe, expect, it } from "vitest";
import { printable, visible } from "../src/formatters/printable.js";

describe("visible", () => {
  it("shows control characters as their escapes: escape, NUL, bell, DEL and the C1 controls (one of which is the CSI)", () => {
    expect(visible("a\u001b[31mred\u001b[0m\u0000\u0007\u007f\u009b")).toBe("a\\x1b[31mred\\x1b[0m\\x00\\x07\\x7f\\x9b");
  });

  it("keeps tabs and line breaks, and reads Windows and old Mac line breaks as line breaks (a bare carriage return would overwrite the line)", () => {
    expect(visible("a\tb\r\nc\rd\ne")).toBe("a\tb\nc\nd\ne");
  });

  it("shows the characters that reorder text on screen as their escapes", () => {
    expect(visible("run ‮txt.exe‬ now")).toBe("run \\u202etxt.exe\\u202c now");
  });

  it("leaves text alone: accents, dashes, emoji, CJK", () => {
    const text = "héllo — ok 🙂 日本語 Tiếng Việt";
    expect(visible(text)).toBe(text);
  });
});

describe("printable", () => {
  it("cleans every string of a structure, keys included, and nothing else", () => {
    const when = new Date("2026-11-08T04:46:12.000Z");
    const input = { "k\u001b": ["a\u001b", { deep: "b\u0007" }], n: 3, t: true, none: null, when };
    const output = printable(input);
    expect(output).toEqual({ "k\\x1b": ["a\\x1b", { deep: "b\\x07" }], n: 3, t: true, none: null, when });
    expect(output.when).toBe(when);
  });

  it("does not change what it was given", () => {
    const input = { text: "a\u001b" };
    printable(input);
    expect(input.text).toBe("a\u001b");
  });
});
