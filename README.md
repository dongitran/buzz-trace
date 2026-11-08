# buzz-trace

[![CI](https://github.com/dongitran/buzz-trace/actions/workflows/ci.yml/badge.svg)](https://github.com/dongitran/buzz-trace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

**Distributed Thread Observability & Diagnostic CLI for Multi-Agent Nostr Networks.**

`buzz-trace` bridges the observability gap in decentralized multi-agent architectures. It correlates distributed OpenTelemetry and OpenInference traces emitted by multiple autonomous agents across a single Nostr thread, producing a unified chronological execution timeline with automated anomaly detection.

---

## 🌟 Key Features

* **Thread-Centric Correlation**: Unifies isolated per-turn traces across multiple agents into a single thread execution view using the Nostr root event ID (`session.id`).
* **Multi-Agent Timeline**: Visualizes interleaved turns between different agents (`@phoenix-twin`, `@paul-twin`, etc.) with model usage, wall latency, and token consumption.
* **Dual-Tier Ingestion**:
  * **Remote / Container**: Queries Arize Phoenix via standard HTTP REST API (`/v1/projects/...`).
  * **Direct Host Local**: Reads Arize Phoenix SQLite database directly (`mode=ro`, <5ms latency) powered by **`UNION` covering index optimization** yielding up to 15,000x query speedups.
* **Semantic Tool Compactor**:
  * Eliminates the 2.77x JSON escaping penalty and nested subshell backslash bloat.
  * Delivers a 47% token reduction in tool input summaries for autonomous agent context windows.
* **Causal DAG & Branch Hardening**:
  * Cycle guard in `assignBranches` eliminates stack overflow recursion on cyclic trace graphs.
  * Robust topological sorting with microsecond tie-breaking across concurrent multi-agent turns.
  * **Honest edges**: agents started by one message are siblings; a reply to an agent's own message is linked as `INFERRED` (and `AMBIGUOUS_PARENT` names the other candidates); only `REPLY_TO` is exact.
* **Buzz-aware turns**: reads the Buzz envelope in the prompt (who asked what, parent, root) and the text each turn *posted*, so previews show the question and the answer, not metadata.
* **Cost & context per call**: cost and cache use per turn and thread; a turn's prompt tokens are summed over its model calls, so buzz-trace estimates the context of *one* call (tool steps + 1) and warns on `CONTEXT_GROWTH` round after round.
* **Automated Diagnostic Intelligence**:
  * Detects `context canceled` premature turn terminations.
  * Flags **`INVALID_DURATION`** anomalies from monotonic clock jumps, with automatic non-negative duration clamping.
  * Identifies tool execution failures, stderr errors, and `CAUSAL_OVERLAP`.
  * Flags **Tool Loops** (identical consecutive tool invocations), **Token Bloat** (>150k tokens in one model call) and **Context Growth** (an agent's context per call doubling over a thread).
* **Multiple Output Modalities**:
  * **Terminal**: Clean ANSI color formatting, trees, and badges for human engineers.
  * **AI JSON (`--json`)**: Compact, structured JSON optimized for LLM prompts and autonomous subagents.
  * **Markdown (`--markdown`)**: Ready-to-paste tables and breakdowns for GitLab MRs, GitHub PRs, and incident postmortems.
* **Zero Runtime Dependencies**: Built entirely with Node.js native standard modules (`fetch`, `node:sqlite`, `node:util`).

---

## 🚀 Quick Start

### Run Instantly via `npx` (No Installation Required)

```bash
npx buzz-trace inspect <nostr_thread_root_id>
```

### Global Installation

```bash
npm install -g buzz-trace
buzz-trace inspect <nostr_thread_root_id>
```

---

## 📖 Usage Examples

### 1. Inspect a Thread Execution
```bash
# Basic inspection of a Nostr thread root event
buzz-trace inspect a519f713413dea676f4b1e72c1756869c55299988da5cd11d6e81b49fe35d2f3

# Specify remote Phoenix server & project
buzz-trace inspect a519f713... --endpoint http://solace-phoenix:6006 --project mobile
```

### 2. High-Speed Direct SQLite Inspection
When running locally on the Docker host:
```bash
buzz-trace inspect a519f713... --db /root/.phoenix/phoenix.db
```

A Phoenix with authentication on (`PHOENIX_ENABLE_AUTH=true`) answers the REST API only with an API key:
```bash
PHOENIX_API_KEY=... buzz-trace query a519f713... --endpoint https://phoenix.example.com --project ba
```
Without a key and without `--db`, buzz-trace stops with exit code 2 and says so (it never reports an auth failure as
`NOT_FOUND`). A thread that is really nowhere is `NOT_FOUND` and lists in `tried` every place it looked, with the age of
any SQLite file: an auto-detected `~/.phoenix/phoenix.db` can be a stale copy.

### 3. AI Agent Self-Reflection & Compact Query Mode (<200 tokens)
Designed specifically for LLM context preservation and subagent evaluation:
```bash
# Query thread health with zero tool errors in <80 tokens
buzz-trace query a519f713... --failures --compact --json

# Tail the most recent turn and inspect tool executions in <150 tokens
buzz-trace query a519f713... --last 1 --compact --json

# Inspect turn 2's specific tools and parameters
buzz-trace query a519f713... --turn 2 --tools --compact --json

# Filter turns executing specific commands or scripts via --tool-input / --cmd
buzz-trace query a519f713... --cmd "git status" --compact --json
buzz-trace query a519f713... --tool-input "buzz messages send" --compact --flat
```

### 4. Next-Gen Differential Trace Analysis (`buzz-trace diff`)
Compare two agent turns, prompt runs, or model variants to detect latency regressions and tool failures:
```bash
# Compare Turn 1 vs Turn 2 within a thread
buzz-trace diff <thread_id>#1 <thread_id>#2 --flat

# Compare two distinct traces
buzz-trace diff <trace1> <trace2> --flat
```
Outputs model changes, $\Delta$ latency (ms), $\Delta$ token counts, tool execution count diffs, and tool status transitions.

### 5. Adaptive Context Summarizer Under Strict Token Budgets (`buzz-trace context`)
Auto-trims thread history to fit within a strict token budget (e.g. 200 or 500 tokens) for autonomous AI context windows:
```bash
# Auto-trims to fit within exactly 200 tokens
buzz-trace context <thread_id> --budget 200 --flat
```
Prioritizes: (1) Root user intent, (2) Latest turn outcome, (3) Failed tools and error diagnostics, while pruning successful intermediate chatter.

### 6. Install Global AI Skill
Integrates `buzz-trace` directly into Claude Code and cross-agent environments (`~/.claude/skills` and `~/.agents/skills`):
```bash
# Install or symlink skill globally
buzz-trace install-skill

# Force overwrite or preview actions
buzz-trace install-skill --force
buzz-trace install-skill --dry-run
```

### 5. Markdown Report Generation
```bash
# Generate markdown for GitLab MRs / GitHub issues
buzz-trace inspect a519f713... --markdown > incident-report.md
```

### 6. Automated Health Diagnostics
```bash
# Runs anomaly checks; exits with code 1 if critical issues (e.g. context canceled or loops) are found
buzz-trace analyze a519f713...
```

### 7. Live Execution Watch
```bash
# Continuously watches thread turns in real-time as agents respond
buzz-trace watch a519f713... --interval 2.0
```

### 8. List Active Sessions
```bash
# View recent sessions and traces recorded in Phoenix
buzz-trace sessions --project mobile --limit 10
```

---

## ⚙️ Configuration & Environment Variables

`buzz-trace` auto-detects configuration from CLI flags or standard environment variables:

| Variable | CLI Flag | Default | Description |
| :--- | :--- | :--- | :--- |
| `PHOENIX_ENDPOINT` | `--endpoint` | `http://localhost:6006` | Arize Phoenix base URL |
| `PHOENIX_PROJECT` | `--project` | `mobile` | Arize Phoenix project name |
| `PHOENIX_DB_PATH` | `--db` | Auto-detected | Path to local `phoenix.db` |
| `PHOENIX_API_KEY` | `--api-key` | none | Phoenix API key (Bearer), for a server with authentication on |
| `NO_COLOR` | `--no-color` | `0` | Disables ANSI terminal coloring |

---

## 🏗️ Architecture

```
[ Human / AI Agent ]
        │
        │ runs: buzz-trace inspect <thread_root_id>
        ▼
 ┌───────────────────────────────────────────────────────────────┐
 │                       buzz-trace CLI                          │
 └──────────────┬───────────────────────────────┬────────────────┘
                │ (1) Query telemetry           │ (2) Query chat text
                ▼                               ▼
 ┌──────────────────────────────┐ ┌──────────────────────────────┐
 │    Arize Phoenix REST API    │ │      Nostr Relay Client      │
 │    (http://localhost:6006)   │ │  (wss://mobile.communities)  │
 ├──────────────────────────────┤ ├──────────────────────────────┤
 │ • GET /v1/projects/.../spans │ │ • REQ kind:1                 │
 │   ?attribute=session.id=...  │ │   #e = thread_root_id        │
 │ • GET /v1/sessions/...       │ │                              │
 └──────────────┬───────────────┘ └─────────────┬────────────────┘
                │ Traces, Spans,                │ Chat contents,
                │ Tools, Tokens                 │ Author pubkeys
                └───────────────┬───────────────┘
                                ▼
 ┌───────────────────────────────────────────────────────────────┐
 │               buzz-trace Aggregator & Analyzer                │
 ├───────────────────────────────────────────────────────────────┤
 │  • Assembles chronological multi-agent turn sequence          │
 │  • Computes cumulative tokens and duration                    │
 │  • Evaluates anomaly rules (cancellations, loops, bloat)      │
 └──────────────────────────────┬────────────────────────────────┘
                                ▼
         Terminal UI  │  AI JSON Stream  │  Markdown
```

---

## 🧪 Development & Testing

```bash
# Install dependencies
npm install

# Run TypeScript typecheck
npm run typecheck

# Run linter
npm run lint

# Run unit tests
npm test

# Run tests with coverage
npm run test:coverage

# Build executable distribution
npm run build
```

---

## 📄 License

MIT License.

---

<p align="center">Made with ❤️ to make your work life easier!</p>
