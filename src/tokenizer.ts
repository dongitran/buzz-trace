/**
 * Token counter utility using BPE tokenizer (gpt-tokenizer) with heuristic fallback.
 */

import { countTokens as gptCountTokens } from "gpt-tokenizer";

/**
 * Counts exact tokens for a given string using BPE o200k_base tokenizer.
 * Falls back to character length heuristic if input causes tokenizer exception.
 */
export function countTokens(text: string): number {
  if (!text) {return 0;}
  try {
    return gptCountTokens(text);
  } catch {
    // Standard LLM BPE approximation: ~3.8 characters per token
    return Math.ceil(text.length / 3.8);
  }
}

/**
 * Checks whether text is strictly within a token limit.
 */
export function isWithinTokenLimit(text: string, limit: number): boolean {
  return countTokens(text) <= limit;
}
