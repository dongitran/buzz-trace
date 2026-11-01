#!/usr/bin/env node

/**
 * Command-Line Interface (CLI) entry point for buzz-trace.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PhoenixClient, PhoenixDBClient, type PhoenixSession } from "./clients/index.js";
import { Config, ConfigOptions } from "./config.js";
import { ThreadAggregator, AnomalyDetector, ThreadQueryEngine, TraceDiffer, ContextSummarizer } from "./engine/index.js";
import { JsonRenderer, MarkdownRenderer, TerminalRenderer } from "./formatters/index.js";
import { SpanNode, ThreadTelemetry } from "./models.js";

const VERSION = "0.1.7";

const HELP_TEXT = `
buzz-trace ${VERSION}
Distributed Thread Observability & Diagnostic CLI for Multi-Agent Nostr Networks

USAGE:
  buzz-trace <command> [arguments] [options]

COMMANDS:
  inspect <thread_id>   Inspect telemetry timeline for a Nostr thread ID
  query <thread_id>     Query & filter thread conversation history (for AI self-reflection)
  diff <trace1> <trace2> Compare two agent turns/traces (models, duration Δ, tokens Δ, tools)
  context <thread_id>   Adaptive context summarizer prioritizing intent, outcome & failed tools
  analyze <thread_id>   Perform automated diagnostic & anomaly detection on a thread
  sessions              List recent active sessions and thread traces
  watch <thread_id>     Live monitor thread execution in real-time
  install-skill         Install buzz-trace skill to AI agent runtimes (~/.claude, ~/.agents)

OPTIONS:
  --endpoint <url>      Arize Phoenix server endpoint (default: http://localhost:6006)
  --ui-endpoint <url>   Arize Phoenix Web UI base URL (for clickable links)
  --project <name>      Arize Phoenix project name (default: mobile)
  --db <path>           Direct path to Phoenix SQLite database file (mode=ro)
  --budget <num>        Token budget limit for context command (e.g. 200, 500)
  --turn1 <num>         First turn index for diff comparison
  --turn2 <num>         Second turn index for diff comparison
  --json                Output AI-optimized structured JSON
  --compact             Emit token-optimized compact output (<250 tokens for LLM context)
  --flat                Emit unindented single-line JSON (saves 25-30% token budget)
  --failures, --errors  Filter turns with non-zero exit code, tool errors, or anomalies
  --tools               Filter turns containing tool executions
  --tool <name>         Filter turns invoking a specific tool (e.g. run_command)
  --agent <name>        Filter turns by agent name (e.g. phoenix-twin, agent-builder)
  --last <num>          Tail the last N chronological turns
  --turn <num>          Inspect a specific turn by 1-based index
  --target <dir>        Explicit target directory for install-skill
  --force               Force overwrite existing skill files/symlinks
  --dry-run             Preview install-skill actions without writing to disk
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
  flat?: boolean;
  markdown?: boolean;
  failures?: boolean;
  tools?: boolean;
  toolName?: string;
  toolInput?: string;
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
    toolInput: flags.toolInput,
    agentFilter: flags.agent,
    lastN: flags.last ? parseInt(flags.last, 10) : undefined,
    targetTurn: flags.turn ? parseInt(flags.turn, 10) : undefined,
  });

  if (flags.json) {
    const renderer = new JsonRenderer(flags.flat ? 0 : 2);
    console.log(renderer.render(telemetry, { compact: flags.compact, flat: flags.flat, config }));
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
  if (flags.failures || flags.tools || flags.toolName || flags.toolInput || flags.agent || flags.last || flags.turn || flags.compact || flags.flat) {
    return runQuery(threadId, config, flags);
  }

  const telemetry = await fetchThreadTelemetry(config, threadId);

  if (flags.json) {
    const renderer = new JsonRenderer(flags.flat ? 0 : 2);
    console.log(renderer.render(telemetry, { compact: flags.compact, flat: flags.flat, config }));
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
  flags: { json?: boolean; compact?: boolean; flat?: boolean; markdown?: boolean; noColor?: boolean },
): Promise<number> {
  const telemetry = await fetchThreadTelemetry(config, threadId);

  if (flags.json) {
    const renderer = new JsonRenderer(flags.flat ? 0 : 2);
    console.log(renderer.render(telemetry, { compact: flags.compact, flat: flags.flat, config }));
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

export interface DiffFlags {
  json?: boolean;
  compact?: boolean;
  flat?: boolean;
  turn1?: string;
  turn2?: string;
  noColor?: boolean;
}

export function parseTargetSpec(spec: string): { id: string; turnIndex?: number } {
  const match = spec.match(/^([^#:]+)[#:]([0-9]+)$/);
  if (match) {
    return { id: match[1], turnIndex: parseInt(match[2], 10) };
  }
  return { id: spec };
}

export async function runDiff(
  target1: string | undefined,
  target2: string | undefined,
  config: Config,
  flags: DiffFlags,
  extraPositional?: string,
): Promise<number> {
  if (!target1) {
    console.error("Error: 'diff' requires at least one target argument.");
    return 1;
  }

  let spec1: { id: string; turnIndex?: number };
  let spec2: { id: string; turnIndex?: number };

  if (extraPositional && target2 && /^\d+$/.test(target2) && /^\d+$/.test(extraPositional)) {
    // E.g. buzz-trace diff <thread> 1 2
    spec1 = { id: target1, turnIndex: parseInt(target2, 10) };
    spec2 = { id: target1, turnIndex: parseInt(extraPositional, 10) };
  } else if (target2 && /^\d+$/.test(target2)) {
    // E.g. buzz-trace diff <thread> 2 (comparing turn 1 with turn 2)
    spec1 = { id: target1, turnIndex: flags.turn1 ? parseInt(flags.turn1, 10) : 1 };
    spec2 = { id: target1, turnIndex: parseInt(target2, 10) };
  } else if (target2) {
    // E.g. buzz-trace diff <target1> <target2>
    spec1 = parseTargetSpec(target1);
    spec2 = parseTargetSpec(target2);
  } else if (flags.turn1 && flags.turn2) {
    // E.g. buzz-trace diff <thread> --turn1 1 --turn2 2
    spec1 = { id: target1, turnIndex: parseInt(flags.turn1, 10) };
    spec2 = { id: target1, turnIndex: parseInt(flags.turn2, 10) };
  } else {
    console.error("Error: 'diff' requires two targets to compare (e.g. 'buzz-trace diff <trace1> <trace2>' or 'buzz-trace diff <thread>#1 <thread>#2').");
    return 1;
  }

  // Fetch telemetry for spec1
  const telemetryA = await fetchThreadTelemetry(config, spec1.id);
  const resolvedA = TraceDiffer.resolveTurnFromTelemetry(telemetryA, target1, spec1.turnIndex);

  // Fetch telemetry for spec2 (reuse telemetryA if same thread)
  const telemetryB = spec2.id === spec1.id ? telemetryA : await fetchThreadTelemetry(config, spec2.id);
  const resolvedB = TraceDiffer.resolveTurnFromTelemetry(telemetryB, target2 || target1, spec2.turnIndex);

  const differ = new TraceDiffer();
  const result = differ.diff(resolvedA.turn, resolvedB.turn, resolvedA.meta, resolvedB.meta);

  if (flags.flat) {
    console.log(JSON.stringify(result));
  } else if (flags.json || flags.compact) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(TraceDiffer.renderTerminal(result, !flags.noColor));
  }

  return 0;
}

export interface ContextFlags {
  budget?: string;
  flat?: boolean;
  json?: boolean;
  compact?: boolean;
  noColor?: boolean;
}

export async function runContext(
  threadId: string | undefined,
  config: Config,
  flags: ContextFlags,
): Promise<number> {
  if (!threadId) {
    console.error("Error: 'context' requires a thread_id argument.");
    return 1;
  }

  const telemetry = await fetchThreadTelemetry(config, threadId);
  const budgetNum = flags.budget ? parseInt(flags.budget, 10) : 500;

  const summarizer = new ContextSummarizer();
  const summary = summarizer.summarize(telemetry, {
    budget: budgetNum,
    flat: flags.flat,
  });

  const isJsonPreferred = flags.json || flags.compact || flags.flat;
  const rendered = ContextSummarizer.render(summary, {
    flat: flags.flat,
    json: isJsonPreferred,
    noColor: flags.noColor,
  });

  console.log(rendered);
  return summary.status === "ERROR" ? 1 : 0;
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

export function findPackageRoot(fromUrlOrPath?: string): string {
  try {
    let curr: string;
    if (fromUrlOrPath) {
      curr = fromUrlOrPath.startsWith("file:") ? path.dirname(fileURLToPath(fromUrlOrPath)) : path.resolve(fromUrlOrPath);
    } else {
      curr = path.dirname(fileURLToPath(import.meta.url));
    }

    while (curr !== path.dirname(curr)) {
      const pkgJsonPath = path.join(curr, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        return curr;
      }
      curr = path.dirname(curr);
    }
  } catch {
    // fallback
  }
  return path.resolve(process.cwd());
}

export interface InstallSkillOptions {
  target?: string;
  force?: boolean;
  dryRun?: boolean;
  packageRoot?: string;
  homedir?: string;
  symlinkFn?: (target: string, path: string, type?: string) => void;
}

export function runInstallSkill(options: InstallSkillOptions = {}): number {
  const pkgRoot = options.packageRoot || findPackageRoot();
  const skillSourceDir = path.join(pkgRoot, "skills", "buzz-trace");
  const skillFile = path.join(skillSourceDir, "SKILL.md");

  if (!fs.existsSync(skillFile)) {
    console.error(`Error: Skill definition not found at: ${skillFile}`);
    return 1;
  }

  const targetDirs: string[] = [];
  if (options.target) {
    let resolved = path.resolve(options.target);
    if (path.basename(resolved) !== "buzz-trace") {
      resolved = path.join(resolved, "buzz-trace");
    }
    targetDirs.push(resolved);
  } else {
    const home = options.homedir || os.homedir();
    targetDirs.push(path.join(home, ".claude", "skills", "buzz-trace"));
    targetDirs.push(path.join(home, ".agents", "skills", "buzz-trace"));
  }

  console.log(`Installing buzz-trace skill from: ${skillSourceDir}`);
  if (options.dryRun) {
    console.log("[dry-run] Would install skill to:");
    for (const dest of targetDirs) {
      console.log(`  - ${dest}`);
    }
    return 0;
  }

  const symlinkType = process.platform === "win32" ? "junction" : "dir";
  const symlink = options.symlinkFn || fs.symlinkSync;
  let successCount = 0;

  for (const dest of targetDirs) {
    try {
      const parentDir = path.dirname(dest);
      fs.mkdirSync(parentDir, { recursive: true });

      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(dest);
      } catch {
        stat = null;
      }

      if (stat) {
        if (stat.isSymbolicLink()) {
          try {
            const currentTarget = fs.readlinkSync(dest);
            if (path.resolve(parentDir, currentTarget) === path.resolve(skillSourceDir) && !options.force) {
              console.log(`  [up-to-date] ${dest}`);
              successCount++;
              continue;
            }
          } catch {
            // Dangling or invalid link
          }
        }

        if (!options.force) {
          console.log(`  [exists] ${dest} (use --force to overwrite)`);
          successCount++;
          continue;
        }
        fs.rmSync(dest, { recursive: true, force: true });
      }

      // Create atomic symlink with fallback to recursive copy
      const tempDest = path.join(
        parentDir,
        `.tmp-skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );

      let installedViaSymlink = false;
      try {
        symlink(skillSourceDir, tempDest, symlinkType);
        try {
          fs.renameSync(tempDest, dest);
        } catch {
          if (stat) {
            fs.rmSync(dest, { recursive: true, force: true });
          }
          fs.renameSync(tempDest, dest);
        }
        installedViaSymlink = true;
      } catch {
        try {
          fs.rmSync(tempDest, { recursive: true, force: true });
        } catch {
          // ignore
        }
        if (stat) {
          fs.rmSync(dest, { recursive: true, force: true });
        }
        fs.cpSync(skillSourceDir, dest, { recursive: true });
      }

      console.log(`  ✓ ${installedViaSymlink ? "Linked (symlink)" : "Copied"} -> ${dest}`);
      successCount++;
    } catch (err) {
      console.error(`  ✗ Failed to install to ${dest}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return successCount > 0 ? 0 : 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const optionsConfig = {
    endpoint: { type: "string" as const },
    "ui-endpoint": { type: "string" as const },
    project: { type: "string" as const },
    db: { type: "string" as const },
    json: { type: "boolean" as const, default: false },
    compact: { type: "boolean" as const, default: false },
    flat: { type: "boolean" as const, default: false },
    failures: { type: "boolean" as const, default: false },
    errors: { type: "boolean" as const, default: false },
    tools: { type: "boolean" as const, default: false },
    tool: { type: "string" as const },
    "tool-input": { type: "string" as const },
    cmd: { type: "string" as const },
    agent: { type: "string" as const },
    budget: { type: "string" as const },
    turn1: { type: "string" as const },
    turn2: { type: "string" as const },
    last: { type: "string" as const },
    turn: { type: "string" as const },
    target: { type: "string" as const },
    force: { type: "boolean" as const, default: false },
    "dry-run": { type: "boolean" as const, default: false },
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

  const isJsonPreferred = values.json || (!values.markdown && Boolean(values.compact || values.flat));
  const isCompactPreferred = values.compact || Boolean(values.flat);

  const queryFlags: QueryFlags = {
    json: isJsonPreferred,
    compact: isCompactPreferred,
    flat: values.flat,
    markdown: values.markdown,
    failures: values.failures || values.errors,
    tools: values.tools || Boolean(values.tool) || Boolean(values["tool-input"] || values.cmd),
    toolName: values.tool,
    toolInput: values["tool-input"] || values.cmd,
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
          json: isJsonPreferred,
          compact: isCompactPreferred,
          flat: values.flat,
          markdown: values.markdown,
          noColor: values["no-color"],
        });
      }
      case "diff": {
        const targetA = positionals[1];
        const targetB = positionals[2];
        const extraPos = positionals[3];
        return await runDiff(
          targetA,
          targetB,
          config,
          {
            json: isJsonPreferred,
            compact: isCompactPreferred,
            flat: values.flat,
            turn1: values.turn1,
            turn2: values.turn2,
            noColor: values["no-color"],
          },
          extraPos,
        );
      }
      case "context": {
        if (!targetId) {
          console.error("Error: 'context' requires a thread_id argument.");
          return 1;
        }
        return await runContext(targetId, config, {
          budget: values.budget,
          flat: values.flat,
          json: isJsonPreferred,
          compact: isCompactPreferred,
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
      case "install-skill": {
        return runInstallSkill({
          target: values.target,
          force: values.force,
          dryRun: values["dry-run"],
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
