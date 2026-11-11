/**
 * Making recorded text safe to print.
 *
 * A transcript prints what tools and web pages returned, whole. Such text can hold escape sequences that move the cursor, clear
 * the screen, set the window title or rewrite what is already on screen, and characters that reorder text so that it reads
 * differently from what it is. In a terminal or a report they are shown, not sent: as their escapes. The JSON form keeps the exact
 * text (JSON escapes it already).
 */

/** The C0 controls but tab and line feed, DEL, and the C1 controls (one of which, 0x9b, is a control-sequence introducer). */
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Marks, embeddings, overrides and isolates that change the order text is drawn in. */
const REORDERING = /[‎‏‪-‮⁦-⁩]/g;

/**
 * The text as it can be printed: line breaks of any kind are `\n` (a bare carriage return would send the cursor back and
 * overwrite the line), tabs stay, every other control and reordering character becomes its escape (`\x1b`, `‮`).
 */
export function visible(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(CONTROLS, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .replace(REORDERING, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A copy of a structure with every string, keys included, made printable. Dates and numbers pass; the input is not touched. */
export function printable<T>(value: T): T {
  if (typeof value === "string") {
    return visible(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => printable(item)) as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [visible(key), printable(item)])) as T;
  }
  return value;
}
