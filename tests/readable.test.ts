/**
 * The readable form of a JSON value, for a person reading a transcript in a terminal: strings as they were written (a message
 * with quotes and line breaks must not be a line of backslashes), nesting by indentation. It is for reading, not for parsing: the
 * JSON output is the exact form.
 */
import { describe, expect, it } from "vitest";
import { readableLines } from "../src/formatters/readable.js";

describe("readableLines", () => {
  it("writes an object as one line per key, strings without quotes or escapes", () => {
    expect(readableLines({ spoken: true, result: 'He said "stop" - it\'s fine.', n: 3, none: null })).toEqual([
      "spoken: true",
      'result: He said "stop" - it\'s fine.',
      "n: 3",
      "none: null",
    ]);
  });

  it("writes a string with line breaks as a block under its key, line breaks kept", () => {
    expect(readableLines({ text: "Huddle summary.\n\n1. BOM\n2. MRP", after: 1 })).toEqual(["text: |", "  Huddle summary.", "", "  1. BOM", "  2. MRP", "after: 1"]);
  });

  it("nests objects and lists by two spaces, a list of objects as dashes", () => {
    expect(
      readableLines({ meeting_id: "94f", heard: [{ at: "00:11", speaker: "Elio Tran", text: "Hi. Kent." }], others: [{ name: "Elio Tran" }], context: [], extra: {} }),
    ).toEqual([
      "meeting_id: 94f",
      "heard:",
      "  - at: 00:11",
      "    speaker: Elio Tran",
      "    text: Hi. Kent.",
      "others:",
      "  - name: Elio Tran",
      "context: []",
      "extra: {}",
    ]);
  });

  it("writes a list of plain values as dashes", () => {
    expect(readableLines({ list: [1, "x", true, null] })).toEqual(["list:", "  - 1", "  - x", "  - true", "  - null"]);
  });

  it("nests a block of text in a list, and an object inside an object inside a list", () => {
    expect(readableLines({ l: ["a\nb"] })).toEqual(["l:", "  - |", "    a", "    b"]);
    expect(readableLines([{ a: { b: [1] } }])).toEqual(["- a:", "    b:", "      - 1"]);
  });

  it("shows an empty string as two quotes, so that it is not mistaken for a missing value", () => {
    expect(readableLines({ t: "" })).toEqual(['t: ""']);
  });

  it("writes a value that is only text as its lines, and reads Windows line breaks as line breaks", () => {
    expect(readableLines("one line")).toEqual(["one line"]);
    expect(readableLines("first\r\nsecond")).toEqual(["first", "second"]);
  });
});
