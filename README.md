# buzz-trace

[![CI](https://github.com/dongitran/buzz-trace/actions/workflows/ci.yml/badge.svg)](https://github.com/dongitran/buzz-trace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Python Version](https://img.shields.io/badge/python-3.9%2B-brightgreen.svg)](https://www.python.org/)

**Distributed Thread Observability & Diagnostic CLI for Multi-Agent Nostr Networks.**

`buzz-trace` bridges the observability gap in decentralized multi-agent architectures. It correlates distributed OpenTelemetry / OpenInference traces emitted by multiple autonomous agents across a single Nostr thread, producing a unified, chronological execution timeline with automated anomaly detection.

---

## 🌟 Key Features

* **Thread-Centric Correlation**: Unifies isolated per-turn traces across multiple agents into a single thread execution view using the Nostr root event ID (`session.id`).
* **Multi-Agent Timeline**: Visualizes interleaved turns between different agents (`@phoenix-twin`, `@paul-twin`, etc.) with model usage, wall latency, and token consumption.
* **Dual-Tier Ingestion**:
  * **Remote / Container**: Queries Arize Phoenix via standard HTTP REST API (`/v1/projects/...`).
  * **Direct Host Local**: Reads Arize Phoenix SQLite database directly (`mode=ro`, <5ms latency).
* **Automated Diagnostic Intelligence**:
  * Detects `context canceled` premature turn terminations.
  * Identifies tool execution failures and stderr errors.
  * Flags **Tool Loops** (identical consecutive tool invocations).
  * Warns on **Token Bloat** (>150k context inflation).
* **Multiple Output Modalities**:
  * **Terminal**: Clean ANSI color formatting, trees, and badges for human engineers.
  * **AI JSON (`--json`)**: Compact, structured JSON optimized for LLM prompts and autonomous subagents.
  * **Markdown (`--markdown`)**: Ready-to-paste tables and breakdowns for GitLab MRs, GitHub PRs, and incident postmortems.
* **Zero Heavy Dependencies**: Built entirely with Python's standard library for maximum portability across containerized agent sandboxes.

---

## 🚀 Quick Start

### Installation

```bash
# Clone and install locally
git clone https://github.com/dongitran/buzz-trace.git
cd buzz-trace
pip install -e .
```

Or run directly without installation:
```bash
python3 -m buzz_trace.cli --help
```

---

## 📖 Usage Examples

### 1. Inspect a Thread Execution
```bash
# Basic inspection of a Nostr thread root event
buzz-trace inspect a519f713413dea676f4b1e72c1756869c55299988da5cd11d6e81b49fe35d2f3

# Specify a remote Phoenix server & project
buzz-trace inspect a519f713... --endpoint http://solace-phoenix:6006 --project mobile
```

### 2. High-Speed Direct SQLite Inspection
When running locally on the Docker host:
```bash
buzz-trace inspect a519f713... --db /root/.phoenix/phoenix.db
```

### 3. AI / Machine Output Mode
```bash
# Compact JSON schema for LLMs and scripts
buzz-trace inspect a519f713... --json
```

### 4. Markdown Report Generation
```bash
# Generate markdown for GitLab MRs / issues
buzz-trace inspect a519f713... --markdown > incident-report.md
```

### 5. Automated Health Diagnostics
```bash
# Runs anomaly checks; exits with code 1 if critical issues (e.g. context canceled or loops) are found
buzz-trace analyze a519f713...
```

### 6. Live Execution Watch
```bash
# Continuously watches thread turns in real-time as agents respond
buzz-trace watch a519f713... --interval 2.0
```

### 7. List Active Sessions
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

## 🧪 Testing

Run unit tests via `pytest`:
```bash
pytest -v
```

---

## 📄 License

MIT License. Copyright (c) 2026 Đông Trần.
