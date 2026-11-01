/**
 * Semantic Tool Compactor & Escaping Eliminator.
 * Extracts clean command lines and target parameters from stringified JSON tool inputs,
 * eliminating the 2.77x JSON escaping penalty and nested backslash overhead.
 */

import { ToolExecution } from "../models.js";

/**
 * Priority keys for semantic tool input extraction.
 * When a tool input is stringified JSON, these keys represent the primary
 * target, command, or parameter executed by the tool.
 */
export const TOOL_SEMANTIC_KEYS = [
  "CommandLine",
  "commandLine",
  "command",
  "cmd",
  "Path",
  "path",
  "filePath",
  "file_path",
  "query",
  "q",
  "search_query",
  "searchQuery",
  "pattern",
  "url",
  "uri",
  "prompt",
  "message",
  "content",
  "text",
] as const;

/**
 * Normalizes all whitespace (newlines, tabs, repeated spaces) into a single space,
 * preventing layout breakage in terminal boxes, Markdown tables, and JSON previews.
 */
export function cleanWhitespace(val: string): string {
  return val.replace(/\s+/g, " ").trim();
}

/**
 * Extracts the primary value from an object using known priority semantic keys.
 */
function extractFromObject(obj: Record<string, unknown>): string {
  if (Array.isArray(obj)) {
    return cleanWhitespace(
      obj
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .join(" "),
    );
  }

  // 1. Check priority keys
  for (const key of TOOL_SEMANTIC_KEYS) {
    if (key in obj && obj[key] !== undefined && obj[key] !== null) {
      const val = obj[key];
      const strVal = typeof val === "string" ? val : JSON.stringify(val);
      return cleanWhitespace(strVal);
    }
  }

  // 2. Single key-value pair: format cleanly as "key: value"
  const entries = Object.entries(obj);
  if (entries.length === 1) {
    const [k, v] = entries[0];
    const strV = typeof v === "string" ? v : JSON.stringify(v);
    return cleanWhitespace(`${k}: ${strV}`);
  }

  // 3. Fallback: compact JSON representation without whitespace bloat
  return cleanWhitespace(JSON.stringify(obj));
}

/**
 * Regex-based extraction fallback for truncated or malformed JSON strings.
 */
function extractWithRegex(str: string): string {
  const pattern =
    /"(?:CommandLine|commandLine|command|cmd|Path|path|filePath|file_path|query|q|search_query|searchQuery|pattern)":\s*"((?:\\.|[^"\\])*)/;
  const match = str.match(pattern);
  if (match) {
    const unescaped = match[1]
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, " ")
      .replace(/\\r/g, "")
      .replace(/\\t/g, " ");
    return cleanWhitespace(unescaped);
  }
  return cleanWhitespace(str);
}

/**
 * Extracts a clean semantic string from tool input data.
 * Eliminates nested JSON escaping, triple-backslash subshell quotes (`\\\"`),
 * and container boilerplate (e.g. `{"CommandLine":"..."}`).
 *
 * @param input Raw tool input (stringified JSON, object, or plain string)
 * @returns Clean, unescaped, single-line semantic command or parameter string
 */
export function extractSemanticToolInput(input: unknown): string {
  if (input === null || input === undefined) {
    return "";
  }

  if (typeof input === "object") {
    return extractFromObject(input as Record<string, unknown>);
  }

  const str = String(input).trim();
  if (!str) {
    return "";
  }

  if (str.startsWith("{") || str.startsWith("[")) {
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === "object" && parsed !== null) {
        return extractFromObject(parsed as Record<string, unknown>);
      }
      return cleanWhitespace(String(parsed));
    } catch {
      // JSON.parse failed (e.g. truncated JSON or unescaped characters)
      return extractWithRegex(str);
    }
  }

  // Fallback regex search in case JSON is embedded within a string
  const regexResult = extractWithRegex(str);
  if (regexResult && regexResult !== str) {
    return regexResult;
  }

  return cleanWhitespace(str);
}

export interface CompactToolPayload {
  name: string;
  ok: boolean;
  dur_ms: number;
  in: string;
  err?: string;
}

/**
 * Formats a ToolExecution into a clean, compact payload for JSON serialization.
 */
export function formatCompactTool(tool: ToolExecution, maxInputLen = 80): CompactToolPayload {
  const cleanIn = extractSemanticToolInput(tool.inputSummary);
  const truncatedIn = cleanIn.length > maxInputLen ? cleanIn.slice(0, maxInputLen) : cleanIn;

  return {
    name: tool.name,
    ok: tool.statusCode === "OK",
    dur_ms: Math.round(tool.durationMs),
    in: truncatedIn,
    ...(tool.error ? { err: tool.error } : {}),
  };
}
