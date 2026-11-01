/**
 * JSON formatter for buzz-trace.
 * Outputs compact, structured JSON ideal for LLM prompts, subagents, and automated pipelines.
 */

import { ThreadTelemetry } from "../models.js";

export class JsonRenderer {
  readonly indent: number;

  constructor(indent = 2) {
    this.indent = indent;
  }

  render(telemetry: ThreadTelemetry): string {
    return JSON.stringify(telemetry.toJSON(), null, this.indent);
  }
}
