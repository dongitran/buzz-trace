#!/usr/bin/env node

/**
 * Command-Line Interface (CLI) entry point for buzz-trace.
 */

import { parseArgs } from "node:util";
import { PhoenixClient, PhoenixDBClient, type PhoenixSession } from "./clients/index.js";
import { Config, ConfigOptions } from "./config.js";
import { ThreadAggregator, AnomalyDetector, ThreadQueryEngine } from "./engine/index.js";
import { JsonRenderer, MarkdownRenderer, TerminalRenderer } from "./formatters/index.js";
import { SpanNode, ThreadTelemetry } from "./models.js";

const VERSION = "0.1.4";

const HELP_TEXT = `
buzz-trace ${VERSION}
Distributed Thread Observability & Diagnostic CLI for Multi-Agent Nostr Networks

USAGE:
  buzz-trace <command> [arguments] [options]

COMMANDS:
  inspect <thread_id>   Inspect telemetry timeline for a Nostr thread ID
  query <thread_id>     Query & filter thread conversation history (for AI self-reflection)
  analyze <thread_id>   Perform automated diagnostic & anomaly detection on a thread
  sessions              List recent active sessions and thread traces
  watch <thread_id>     Live monitor thread execution in real-time

OPTIONS:
  --endpoint <url>      Arize Phoenix server endpoint (default: http://localhost:6006)
  --ui-endpoint <url>   Arize Phoenix Web UI base URL (for clickable links)
  --project <name>      Arize Phoenix project name (default: mobile)
  --db <path>           Direct path to Phoenix SQLite database file (mode=ro)
  --json                Output AI-optimized structured JSON
  --compact             Emit token-optimized compact output (<250 tokens for LLM context)
  --failures, --errors  Filter turns with non-zero exit code, tool errors, or anomalies
  --tools               Filter turns containing tool executions
  --tool <name>         Filter turns invoking a specific tool (e.g. run_command)
  --agent <name>        Filter turns by agent name (e.g. phoenix-twin, agent-builder)
  --last <num>          Tail the last N chronological turns
  --turn <num>          Inspect a specific turn by 1-based index
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

  const aggregator = new ThreadAggregator(threadId, config.project, null, config.uiEndpoint);
  const telemetry = aggregator.aggregate(spans);

  // Set Phoenix Web UI deep links
  telemetry.phoenixUiUrl = config.uiEndpoint;
  telemetry.phoenixSessionUrl = config.getSessionUrl(telemetry.sessionId, telemetry.threadId);
  for (const turn of telemetry.turns) {
    turn.traceUrl = config.getTraceUrl(turn.traceId);
  }

  const analyzer = new AnomalyDetector();
  analyzer.analyze(telemetry);

  return telemetry;
}

export interface QueryFlags {
  json?: boolean;
  compact?: boolean;
  markdown?: boolean;
  failures?: boolean;
  tools?: boolean;
  toolName?: string;
  agent?: string;
  last?: string;
  turn?: string;
  verbose?: boolean;
  noColor?: boolean;
}

export async function runQuery(
  threadId: string,
  config: Config,
  flags: QueryFlags,
): Promise<number> {
  const rawTelemetry = await fetchThreadTelemetry(config, threadId);

  const queryEngine = new ThreadQueryEngine();
  const telemetry = queryEngine.filter(rawTelemetry, {
    failuresOnly: flags.failures,
    toolsOnly: flags.tools,
    toolName: flags.toolName,
    agentFilter: flags.agent,
    lastN: flags.last ? parseInt(flags.last, 10) : undefined,
    targetTurn: flags.turn ? parseInt(flags.turn, 10) : undefined,
  });

  if (flags.json) {
    const renderer = new JsonRenderer();
    console.log(renderer.render(telemetry, { compact: flags.compact, config }));
  } else if (flags.markdown) {
    const renderer = new MarkdownRenderer();
    console.log(renderer.render(telemetry));
  } else {
    const renderer = new TerminalRenderer(!flags.noColor);
    console.log(renderer.render(telemetry, flags.verbose));
  }

  return telemetry.status === "ERROR" ? 1 : 0;
}

export async function runInspect(
  threadId: string,
  config: Config,
  flags: QueryFlags,
): Promise<number> {
  // If query filter flags are passed to inspect, delegate to runQuery
  if (flags.failures || flags.tools || flags.toolName || flags.agent || flags.last || flags.turn || flags.compact) {
    return runQuery(threadId, config, flags);
  }

  const telemetry = await fetchThreadTelemetry(config, threadId);

  if (flags.json) {
    const renderer = new JsonRenderer();
    console.log(renderer.render(telemetry, { compact: flags.compact, config }));
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
  flags: { json?: boolean; compact?: boolean; markdown?: boolean; noColor?: boolean },
): Promise<number> {
  const telemetry = await fetchThreadTelemetry(config, threadId);

  if (flags.json) {
    const renderer = new JsonRenderer();
    console.log(renderer.render(telemetry, { compact: flags.compact, config }));
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
  let sessions: PhoenixSession[] = [];

  if (config.dbPath) {
    const dbClient = new PhoenixDBClient(config.dbPath);
    sessions = dbClient.listSessions(config.project, limit);
  } else {
    const apiClient = new PhoenixClient(config.endpoint, config.timeout);
    sessions = await apiClient.listSessions(config.project, limit);
  }

  console.log(`\nRECENT SESSIONS · Project: ${config.project} (showing up to ${limit})`);
  console.log("=".repeat(80));

  if (sessions.length === 0) {
    console.log("  No sessions found.");
    return 0;
  }

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const sid = s.session_id || s.id;
    const traces = Array.isArray(s.traces) ? s.traces : [];
    const tokens = typeof s.token_count_total === "number" ? s.token_count_total : 0;
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
    "ui-endpoint": { type: "string" as const },
    project: { type: "string" as const },
    db: { type: "string" as const },
    json: { type: "boolean" as const, default: false },
    compact: { type: "boolean" as const, default: false },
    failures: { type: "boolean" as const, default: false },
    errors: { type: "boolean" as const, default: false },
    tools: { type: "boolean" as const, default: false },
    tool: { type: "string" as const },
    agent: { type: "string" as const },
    last: { type: "string" as const },
    turn: { type: "string" as const },
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
    uiEndpoint: values["ui-endpoint"],
    project: values.project,
    dbPath: values.db,
  };
  const config = Config.load(configOptions);

  const queryFlags: QueryFlags = {
    json: values.json,
    compact: values.compact,
    markdown: values.markdown,
    failures: values.failures || values.errors,
    tools: values.tools || Boolean(values.tool),
    toolName: values.tool,
    agent: values.agent,
    last: values.last,
    turn: values.turn,
    verbose: values.verbose,
    noColor: values["no-color"],
  };

  try {
    switch (command) {
      case "inspect": {
        if (!targetId) {
          console.error("Error: 'inspect' requires a thread_id argument.");
          return 1;
        }
        return await runInspect(targetId, config, queryFlags);
      }
      case "query": {
        if (!targetId) {
          console.error("Error: 'query' requires a thread_id argument.");
          return 1;
        }
        return await runQuery(targetId, config, queryFlags);
      }
      case "analyze": {
        if (!targetId) {
          console.error("Error: 'analyze' requires a thread_id argument.");
          return 1;
        }
        return await runAnalyze(targetId, config, {
          json: values.json,
          compact: values.compact,
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

if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
  main().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
