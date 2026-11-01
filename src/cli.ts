#!/usr/bin/env node

/**
 * Command-Line Interface (CLI) entry point for buzz-trace.
 */

import { parseArgs } from "node:util";
import { PhoenixClient, PhoenixDBClient } from "./clients/index.js";
import { Config, ConfigOptions } from "./config.js";
import { ThreadAggregator, AnomalyDetector } from "./engine/index.js";
import { JsonRenderer, MarkdownRenderer, TerminalRenderer } from "./formatters/index.js";
import { SpanNode, ThreadTelemetry } from "./models.js";

const VERSION = "0.1.1";

const HELP_TEXT = `
buzz-trace ${VERSION}
Distributed Thread Observability & Diagnostic CLI for Multi-Agent Nostr Networks

USAGE:
  buzz-trace <command> [arguments] [options]

COMMANDS:
  inspect <thread_id>   Inspect telemetry timeline for a Nostr thread ID
  analyze <thread_id>   Perform automated diagnostic & anomaly detection on a thread
  sessions              List recent active sessions and thread traces
  watch <thread_id>     Live monitor thread execution in real-time

OPTIONS:
  --endpoint <url>      Arize Phoenix server endpoint (default: http://localhost:6006)
  --project <name>      Arize Phoenix project name (default: mobile)
  --db <path>           Direct path to Phoenix SQLite database file (mode=ro)
  --json                Output AI-optimized structured JSON
  --markdown            Output GitHub/GitLab Markdown report
  --verbose, -v         Include verbose details (e.g. tool output previews)
  --no-color            Disable ANSI color codes
  --limit <num>         Number of items to fetch (for sessions command, default: 10)
  --interval <sec>      Polling interval in seconds for watch command (default: 2.0)
  --help, -h            Show this help message
  --version             Show version
`;

export async function fetchThreadTelemetry(config: Config, threadId: string): Promise<ThreadTelemetry> {
  let spans: SpanNode[] = [];

  if (config.dbPath) {
    const dbClient = new PhoenixDBClient(config.dbPath);
    spans = dbClient.getSpansForThread(threadId);
  } else {
    const apiClient = new PhoenixClient(config.endpoint, config.timeout);
    spans = await apiClient.getSpansForThread(config.project, threadId);
  }

  const aggregator = new ThreadAggregator(threadId, config.project);
  const telemetry = aggregator.aggregate(spans);

  const analyzer = new AnomalyDetector();
  analyzer.analyze(telemetry);

  return telemetry;
}

export async function runInspect(
  threadId: string,
  config: Config,
  flags: { json?: boolean; markdown?: boolean; verbose?: boolean; noColor?: boolean },
): Promise<number> {
  const telemetry = await fetchThreadTelemetry(config, threadId);

  if (flags.json) {
    const renderer = new JsonRenderer();
    console.log(renderer.render(telemetry));
  } else if (flags.markdown) {
    const renderer = new MarkdownRenderer();
    console.log(renderer.render(telemetry));
  } else {
    const renderer = new TerminalRenderer(!flags.noColor);
    console.log(renderer.render(telemetry, flags.verbose));
  }

  return 0;
}

export async function runAnalyze(
  threadId: string,
  config: Config,
  flags: { json?: boolean; markdown?: boolean; noColor?: boolean },
): Promise<number> {
  const telemetry = await fetchThreadTelemetry(config, threadId);

  if (flags.json) {
    const renderer = new JsonRenderer();
    console.log(renderer.render(telemetry));
  } else if (flags.markdown) {
    const renderer = new MarkdownRenderer();
    console.log(renderer.render(telemetry));
  } else {
    const renderer = new TerminalRenderer(!flags.noColor);
    console.log(renderer.render(telemetry, true));
  }

  const hasCritical = telemetry.anomalies.some((a) => a.severity === "CRITICAL");
  return hasCritical ? 1 : 0;
}

export async function runSessions(config: Config, limit = 10): Promise<number> {
  const apiClient = new PhoenixClient(config.endpoint, config.timeout);
  const sessions = await apiClient.listSessions(config.project, limit);

  console.log(`Arize Phoenix Sessions · Project: ${config.project} (Limit: ${limit})`);
  console.log("=".repeat(80));

  if (!sessions || sessions.length === 0) {
    console.log("No sessions found.");
    return 0;
  }

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const sid = s.session_id || s.id;
    const traces = s.traces || [];
    const tokens = s.token_count_total || 0;
    const start = s.start_time || "N/A";
    const idx = String(i + 1).padStart(2, "0");

    console.log(`[${idx}] Session: ${sid} · Traces: ${traces.length} · Tokens: ${tokens.toLocaleString()} · Started: ${start}`);
    for (const t of traces.slice(0, 3)) {
      console.log(`     ├── Trace: ${t.trace_id}`);
    }
    if (traces.length > 3) {
      console.log(`     └── ... (${traces.length - 3} more traces)`);
    }
    console.log("-".repeat(80));
  }

  return 0;
}

export async function runWatch(
  threadId: string,
  config: Config,
  intervalSec = 2.0,
  flags: { verbose?: boolean; noColor?: boolean } = {},
): Promise<number> {
  let lastTurnsCount = -1;
  console.log(`Live monitoring thread: ${threadId} (polling every ${intervalSec}s)... Press Ctrl+C to exit.\n`);

  const poll = async () => {
    try {
      const telemetry = await fetchThreadTelemetry(config, threadId);
      if (telemetry.turns.length !== lastTurnsCount) {
        process.stdout.write("\x1b[2J\x1b[H");
        const renderer = new TerminalRenderer(!flags.noColor);
        console.log(renderer.render(telemetry, flags.verbose));
        lastTurnsCount = telemetry.turns.length;
      }
    } catch (err) {
      process.stderr.write(`Transient error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  await poll();
  const intervalId = setInterval(poll, intervalSec * 1000);

  return new Promise((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(intervalId);
      console.log("\nMonitoring stopped.");
      resolve(0);
    });
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const optionsConfig = {
    endpoint: { type: "string" as const },
    project: { type: "string" as const },
    db: { type: "string" as const },
    json: { type: "boolean" as const, default: false },
    markdown: { type: "boolean" as const, default: false },
    verbose: { type: "boolean" as const, short: "v", default: false },
    "no-color": { type: "boolean" as const, default: false },
    limit: { type: "string" as const, default: "10" },
    interval: { type: "string" as const, default: "2.0" },
    help: { type: "boolean" as const, short: "h", default: false },
    version: { type: "boolean" as const, default: false },
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: optionsConfig,
      allowPositionals: true,
    });
  } catch (err) {
    console.error(`Argument error: ${err instanceof Error ? err.message : String(err)}`);
    console.log(HELP_TEXT);
    return 1;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    console.log(`buzz-trace ${VERSION}`);
    return 0;
  }

  if (values.help || positionals.length === 0) {
    console.log(HELP_TEXT);
    return 0;
  }

  const command = positionals[0];
  const targetId = positionals[1];

  const configOptions: ConfigOptions = {
    endpoint: values.endpoint,
    project: values.project,
    dbPath: values.db,
  };
  const config = Config.load(configOptions);

  try {
    switch (command) {
      case "inspect": {
        if (!targetId) {
          console.error("Error: 'inspect' requires a thread_id argument.");
          return 1;
        }
        return await runInspect(targetId, config, {
          json: values.json,
          markdown: values.markdown,
          verbose: values.verbose,
          noColor: values["no-color"],
        });
      }
      case "analyze": {
        if (!targetId) {
          console.error("Error: 'analyze' requires a thread_id argument.");
          return 1;
        }
        return await runAnalyze(targetId, config, {
          json: values.json,
          markdown: values.markdown,
          noColor: values["no-color"],
        });
      }
      case "sessions": {
        const limitNum = parseInt(values.limit || "10", 10) || 10;
        return await runSessions(config, limitNum);
      }
      case "watch": {
        if (!targetId) {
          console.error("Error: 'watch' requires a thread_id argument.");
          return 1;
        }
        const intervalNum = parseFloat(values.interval || "2.0") || 2.0;
        return await runWatch(targetId, config, intervalNum, {
          verbose: values.verbose,
          noColor: values["no-color"],
        });
      }
      default: {
        console.error(`Unknown command: ${command}`);
        console.log(HELP_TEXT);
        return 1;
      }
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}


