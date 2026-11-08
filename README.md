# buzz-trace

[![CI](https://github.com/dongitran/buzz-trace/actions/workflows/ci.yml/badge.svg)](https://github.com/dongitran/buzz-trace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

**Distributed Thread Observability & Diagnostic CLI for Multi-Agent Nostr Networks.**

`buzz-trace` bridges the observability gap in decentralized multi-agent architectures. It correlates distributed OpenTelemetry and OpenInference traces emitted by multiple autonomous agents across a single Nostr thread, producing a unified chronological execution timeline with automated anomaly detection.

---

## 🌟 Key Features

* **One source: the Phoenix server.** buzz-trace reads Phoenix over its REST API (API key, or email and password). No relay, no `buzz` CLI, no file. It finds the project from the thread, so there is no default project to get wrong.
* **Thread-Centric Correlation**: Unifies isolated per-turn traces across multiple agents into a single thread execution view using the Nostr root event ID (`session.id`).
* **Multi-Agent Timeline**: Visualizes interleaved turns between different agents (`@phoenix-twin`, `@paul-twin`, etc.) with model usage, wall latency, and token consumption.
* **Which turn posted a message**: every report shows the id of each message a turn posted (`212193a2…`) and, for a parent message, the turn that posted it. Exact when the agent's runtime records the id ([telemetry contract](#-telemetry-contract)); for older traces buzz-trace lists the turns that *could* have posted it and picks none.
* **Steered messages**: `Handled 4 messages (3 steered)` with each one's id and text, when the runtime records them; when it does not, the report says that steered messages are not recorded in the trace.
* **Semantic Tool Compactor**:
  * Eliminates the 2.77x JSON escaping penalty and nested subshell backslash bloat.
  * Delivers a 47% token reduction in tool input summaries for autonomous agent context windows.
* **Causal DAG & Branch Hardening**:
  * Cycle guard in `assignBranches` eliminates stack overflow recursion on cyclic trace graphs.
  * Robust topological sorting with microsecond tie-breaking across concurrent multi-agent turns.
  * **Honest edges**: agents started by one message are siblings. `REPLY_TO` is exact (the message started a turn, was taken into one, or a reply span recorded it). `INFERRED` names a turn only when it is the one turn that could have posted the parent message. `AMBIGUOUS` lists the candidates and picks none.
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
* **One runtime dependency** (a tokenizer). The Phoenix client is Node's native `fetch`.

---

## 🚀 Quick Start

```bash
npm install -g buzz-trace          # or: npx buzz-trace …

export PHOENIX_URL=http://phoenix.example.com:6006
export PHOENIX_API_KEY=…           # or PHOENIX_EMAIL + PHOENIX_PASSWORD

buzz-trace inspect <nostr_thread_root_id>
```

A Phoenix without authentication needs only the URL. The project is found from the thread: name one with `--project` or `PHOENIX_PROJECT` only to look in that project alone.

---

## 🔑 Connecting to Phoenix

```
                 ┌─ PHOENIX_API_KEY / --api-key ──▶ Authorization: Bearer <key>
buzz-trace ──────┤
                 └─ PHOENIX_EMAIL + PHOENIX_PASSWORD ──▶ POST /auth/login ──▶ Bearer <access token>
                                                          (refreshed on 401, or signed in again)
```

| | Order of precedence |
| :--- | :--- |
| **Endpoint** | `--endpoint`, `PHOENIX_ENDPOINT`, `PHOENIX_URL`, then `http://localhost:6006` |
| **Credentials** | an API key, if set; else the email and password. A key Phoenix rejects gives way to the email and password when both are set |
| **Project** | `--project`, `PHOENIX_PROJECT`, else **none**: buzz-trace asks Phoenix which project holds the thread (`GET /v1/sessions/{id}` names it), and searches every project for an id that is not a session |

* A secret never appears on screen, in a URL, in an error or in a log: errors are redacted, and a `Config` or client cannot be printed with its credentials. The email and password come from the environment only; prefer `PHOENIX_API_KEY` to `--api-key`, since a flag shows in `ps` and in your shell history.
* A sign-in lasts ten minutes on a default Phoenix (its refresh token, a week), and a Phoenix may rate-limit sign-ins (buzz-trace says so on a 429): for repeated runs use an API key, which needs none.
* Without credentials a Phoenix that wants them answers 401: buzz-trace stops with exit code 2 and says what to set. It never reports that as `NOT_FOUND`.

**What a thread costs.** Two requests when the project is named (the spans that carry the session id, then every span of those traces, since a steer record need not carry it); four when buzz-trace finds the project first. Pages are read to the end (`next_cursor`) and ordered by start time. The same data through the Phoenix CLI would be one process per call (`px session get <root>` names the traces and holds no spans; `px span list --trace-id <id>` per trace; about a second to start each, 18 s and 313 MB the first time through `npx`), with no email and password login: so buzz-trace calls the REST API itself. `px` is a good way to look at the same data by hand, and `px api graphql` (or Phoenix's own `/graphql`) answers a whole session, its traces, spans and events in one request.

---

## 📖 Usage Examples

### 1. Inspect a Thread Execution
```bash
# Inspect a thread: the project is found from the thread
buzz-trace inspect a519f713413dea676f4b1e72c1756869c55299988da5cd11d6e81b49fe35d2f3

# Look only in one project of a given Phoenix
buzz-trace inspect a519f713... --endpoint http://solace-phoenix:6006 --project ba

# Given a trace id, or the id of a message of the thread, finds the thread as well
buzz-trace inspect 212193a2f2f5dbd2955a43f55b191213d5c5b55b161cac89a34d8e9ca95a3773
```

### 2. AI Agent Self-Reflection & Compact Query Mode (<200 tokens)
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

### 3. Next-Gen Differential Trace Analysis (`buzz-trace diff`)
Compare two agent turns, prompt runs, or model variants to detect latency regressions and tool failures:
```bash
# Compare Turn 1 vs Turn 2 within a thread
buzz-trace diff <thread_id>#1 <thread_id>#2 --flat

# Compare two distinct traces
buzz-trace diff <trace1> <trace2> --flat
```
Outputs model changes, $\Delta$ latency (ms), $\Delta$ token counts, tool execution count diffs, and tool status transitions.

### 4. Adaptive Context Summarizer Under Strict Token Budgets (`buzz-trace context`)
Auto-trims thread history to fit within a strict token budget (e.g. 200 or 500 tokens) for autonomous AI context windows:
```bash
# Auto-trims to fit within exactly 200 tokens
buzz-trace context <thread_id> --budget 200 --flat
```
Prioritizes: (1) Root user intent, (2) Latest turn outcome, (3) Failed tools and error diagnostics, while pruning successful intermediate chatter.

### 5. Install Global AI Skill
Integrates `buzz-trace` directly into Claude Code and cross-agent environments (`~/.claude/skills` and `~/.agents/skills`):
```bash
# Install or symlink skill globally
buzz-trace install-skill

# Force overwrite or preview actions
buzz-trace install-skill --force
buzz-trace install-skill --dry-run
```

### 6. Markdown Report Generation
```bash
# Generate markdown for GitLab MRs / GitHub issues
buzz-trace inspect a519f713... --markdown > incident-report.md
```

### 7. Automated Health Diagnostics
```bash
# Runs anomaly checks; exits with code 1 if critical issues (e.g. context canceled or loops) are found
buzz-trace analyze a519f713...
```

### 8. Live Execution Watch
```bash
# Continuously watches thread turns in real-time as agents respond
buzz-trace watch a519f713... --interval 2.0
```

### 9. List Recent Sessions
```bash
# The newest sessions of every project (or of one: --project ba)
buzz-trace sessions --limit 10
```

---

## 🧾 Which Turn Posted a Message?

A person answers an agent's message. To say which turn wrote it, Phoenix would have to hold the id of what each turn posted. It does not, unless the agent's runtime records it:

```
Kent's turn ── reply call ──▶ message 212193a2…     Phoenix holds: the call's text, its time, what it replied to
Paul's turn ── reply call ──▶ message 5724e661…     Phoenix does NOT hold the id of the message a call created
Paul's turn 3 ◀── started by ea3c75b2…, a reply to 212193a2…     Phoenix holds both ids, from the envelope
```

```
Turn 3 · ba-paul-twin [OK]
│  Event ID : ea3c75b2c762198988f5d07246a2c04423abba18e965c1ed33d9a2afde7271f3
│  Handled  : 1 message — steered messages are not recorded in this trace
│  Reply To : message 212193a2… posted by Turn 1 or Turn 2: not recorded, so no parent is picked
│  Posted   : id not recorded  "Yes, I'd keep mine first: the two are nearly the same…"
```

With the contract below, the same turn reads `Reply To : message 212193a2… posted by Turn 1 (ba-kent-twin)` and `Posted   : a3707ece…  "Yes, I'd keep…"`.

### What is and is not derivable

| | Traces written before the contract | Traces that follow it |
| :--- | :--- | :--- |
| Id of a message a turn posted | **Not in Phoenix.** Not in the REST API, GraphQL, span events, annotations or the session and trace objects. (A message id is the hash of the whole event, and Phoenix does not hold all of it: recomputing the id from what Phoenix has did not reproduce a real one.) | `nostr.posted_event_id` on the reply span |
| The turn that posted a parent message | One turn, if exactly one reply call could have created it (it started before the answering turn, did not fail, did not answer that message, and no other message needs the call): `INFERRED`. Several: the **candidates are listed and none is picked** (`AMBIGUOUS`). Checked by hand on five real ba threads against the relay's own thread (which buzz-trace never reads): of 7 such links, 5 inferred, all right; 2 ambiguous, the right turn among the candidates; none wrong | exact (`REPLY_TO`) |
| A parent written by a person | Cannot be told from an agent's: the inference assumes the agent wrote it | not any turn's post: the report says so |
| A message steered into a running turn | Only when a reply call answered it (seen as `inferred from a reply call`, no text); otherwise it is absent | a `steer` span, with id and text |

### 🧬 Telemetry contract

What an agent runtime writes to Phoenix so that buzz-trace is exact. Every name is a constant in [`src/contract.ts`](src/contract.ts).

| What | Where | Value |
| :--- | :--- | :--- |
| Id of a posted message | attribute `nostr.posted_event_id` on the reply tool span (`mcp__buzz-thread__reply`, or any tool that posts) | 64 hex |
| The same, from tool output | `event_id <64 hex>` in that span's `output.value` or `tool.output` (the reply tool returns `posted (N characters) · event_id <hex>`) | text |
| A steered message | a child span named `steer` under the turn's `agent_turn` span, in the same trace, starting when the message was delivered; a span event named `steer` with the same attributes is read too | see below |

```jsonc
// the reply span: what the call replied to, and what it created
{ "name": "tool:mcp__buzz-thread__reply",
  "attributes": { "tool.parameters.reply_to": "fb46eb2a…", "tool.parameters.text": "Kent Twin here…",
                  "nostr.posted_event_id": "212193a2f2f5dbd2955a43f55b191213d5c5b55b161cac89a34d8e9ca95a3773" } }

// a message that arrived while the turn was running
{ "name": "steer", "parent": "<the agent_turn span>", "start_time": "<when it was delivered>",
  "attributes": { "openinference.span.kind": "CHAIN",
                  "nostr.event_id": "9c3d1e7a…",      // the steered message's id (64 hex)
                  "input.value": "One more thing…",   // its text, redacted, at most 8 KB
                  "nostr.sender_name": "Elio Tran",
                  "steer.priority": "now" } }          // or "later"
```

A child span is the contract rather than an event because it shows in Phoenix's trace tree and waterfall and can be filtered by name and attribute through the REST API; an event is accepted too.

### Steered messages

With `turn_handling: steer`, a message that arrives while a turn runs is injected into it and starts no trace, so Phoenix shows one message for four. buzz-trace reads the `steer` records:

```
│  Handled  : 4 messages (3 steered)
│    ↳ steered 9c3d1e7a… (now) "One more thing for the same email: mention the SAP client number."
│    ↳ steered 6e1a22f0… (later) "And please say who on our side will send the data model."
```

Where nothing recorded them, a reply call that answered a message other than the opening one still shows it (`inferred from a reply call; text not recorded`); otherwise the report says `steered messages are not recorded in this trace`.

---

## 🧾 JSON Fields Added in 0.4

| Field | Meaning |
| :--- | :--- |
| `posted_event_ids`, `posts[]` | ids of the messages each turn posted (when recorded), and each reply call: `event_id` (or null), `reply_to`, `text`, `at` |
| `answered_event_ids` | the messages the turn's reply calls answered |
| `handled_messages`, `steered[]` | messages the turn handled, and the steered ones: `event_id`, `text`, `sender`, `priority`, `at`, `source` (`span`, `event` or `reply_call`) |
| `parent_message` | `{ id, basis, posted_by_turn, turns }`; `basis` is `posted`, `started`, `steered`, `inferred`, `ambiguous`, `thread_root` or `unknown` |
| `parent_edge`: `AMBIGUOUS`, `parent_candidates` | no parent is picked; the turns that could have posted the parent message |
| `steering` | `recorded` or `not_recorded` for the thread |

Compact output (`--compact --json`) adds, only when they apply: `parent_msg` and `posted_ids` (the first 8 hex), `edge: "ambiguous"` with `candidates`, `msgs` and `steered`, and a thread-level `steering: "not_recorded"`.

---

## ⚙️ Configuration & Environment Variables

| Variable | CLI Flag | Default | Description |
| :--- | :--- | :--- | :--- |
| `PHOENIX_ENDPOINT`, `PHOENIX_URL` | `--endpoint` | `http://localhost:6006` | Arize Phoenix base URL (in this order of precedence) |
| `PHOENIX_PROJECT` | `--project` | none: found from the thread | Look in this project only |
| `PHOENIX_API_KEY` | `--api-key` | none | Phoenix API key (Bearer) |
| `PHOENIX_EMAIL`, `PHOENIX_PASSWORD` | – | none | Sign in when there is no API key (environment only) |
| `PHOENIX_UI_ENDPOINT` | `--ui-endpoint` | the endpoint | Base URL of the links into the Phoenix UI |
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
 └───────────────────────────────┬───────────────────────────────┘
                                 │ HTTP, Node's native fetch
                                 ▼
 ┌───────────────────────────────────────────────────────────────┐
 │                  Arize Phoenix server (REST)                  │
 │ • POST /auth/login, /auth/refresh   (email + password)        │
 │ • GET /v1/sessions/{id}             (which project holds it)  │
 │ • GET /v1/projects/{p}/spans        (attributes, events)      │
 └───────────────────────────────┬───────────────────────────────┘
                                 ▼
 ┌───────────────────────────────────────────────────────────────┐
 │               buzz-trace Aggregator & Analyzer                │
 ├───────────────────────────────────────────────────────────────┤
 │  • One turn per trace; chronological multi-agent sequence     │
 │  • Posted ids, steered messages, parent message per turn      │
 │  • Candidates when the poster was not recorded                │
 │  • Evaluates anomaly rules (cancellations, loops, bloat)      │
 └───────────────────────────────┬───────────────────────────────┘
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
