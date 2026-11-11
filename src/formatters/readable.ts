/**
 * The readable form of a JSON value, for a person reading a transcript in a terminal or a report.
 *
 * Strings are shown as they were written, not as JSON escapes them: a message with quotes and line breaks stays a message. A
 * string with line breaks becomes a block under its key, an object becomes `key: value` lines, a list becomes dashes, and
 * nesting is two spaces. It is for reading only: values like `true`, `3` and the text "true" look alike here, and the JSON output
 * is the exact form.
 */

const INDENT = "  ";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const textLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

/** A blank line stays blank: no trailing spaces. */
const indent = (line: string): string => (line === "" ? "" : `${INDENT}${line}`);

/** The value as the rest of its line, or null when it needs lines of its own (a block of text, a filled list or object). */
function inline(value: unknown): string | null {
  if (typeof value === "string") {
    return value === "" ? '""' : /[\r\n]/.test(value) ? null : value;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : null;
  }
  if (isObject(value)) {
    return Object.keys(value).length === 0 ? "{}" : null;
  }
  return String(value);
}

function keyed(key: string, value: unknown): string[] {
  const line = inline(value);
  if (line !== null) {
    return [`${key}: ${line}`];
  }
  if (typeof value === "string") {
    return [`${key}: |`, ...textLines(value).map(indent)];
  }
  return [`${key}:`, ...readableLines(value).map(indent)];
}

function listItem(value: unknown): string[] {
  const line = inline(value);
  if (line !== null) {
    return [`- ${line}`];
  }
  if (typeof value === "string") {
    return ["- |", ...textLines(value).map(indent)];
  }
  return readableLines(value).map((text, i) => (i === 0 ? `- ${text}` : indent(text)));
}

/** The lines that show a parsed JSON value (or a text) to a person. */
export function readableLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.length === 0 ? ["[]"] : value.flatMap(listItem);
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    return entries.length === 0 ? ["{}"] : entries.flatMap(([key, item]) => keyed(key, item));
  }
  if (typeof value === "string") {
    return value === "" ? ['""'] : textLines(value);
  }
  return [String(value)];
}
