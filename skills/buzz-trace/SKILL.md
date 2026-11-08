---
name: buzz-trace
description: Use when inspecting, debugging, or querying multi-agent Nostr threads, tool execution logs, or distributed telemetry traces with buzz-trace and Arize Phoenix
---

# buzz-trace

Distributed thread observability, AI query engine, and telemetry diagnostic CLI for multi-agent Nostr networks and Arize Phoenix.

## Core Principles

1. **Micro-Observability vs. Macro-Correlation**:
   - Each agent turn is an independent OpenTelemetry (OTel) trace with its own root span, keeping multi-agent traces unentangled.
   - All turns in a conversation are unified into a single Phoenix session where `session.id = threadRootId` (Nostr root event ID).
2. **Causality DAG Over Clock Skew**:
   - Distributed containers (across WSL2, NUC, cloud VMs) have millisecond clock drifts.
   - Always trust `reply_to` causality edges over raw timestamps for turn sequencing and thread DAG topology.
   - Edges have four strengths. No `edge` field in compact output means an exact link: the parent message started a turn, was taken into one, or a reply span recorded its id (an attribute, or a span annotation written afterwards: compact `parent_basis: "annotation"`). `"edge":"inferred"` means the parent message is recorded nowhere but exactly one turn could have posted it. `"edge":"ambiguous"` means several could have: there is **no `parent`**, and `candidates` lists them. `"edge":"thread_root"` means only the thread's root ties the turn to a turn. Agents started by one message are siblings, never parent and child.
   - Phoenix does not hold the id of a message an agent posted unless its runtime records it (`nostr.posted_event_id`) or someone wrote it as a span annotation of that name. Never treat an `inferred` edge as recorded, and never pick one of `candidates` yourself.
3. **Tokens Are Summed Over Model Calls**:
   - A turn's `tokens` add up every model call of the turn, and each tool step is one more call that re-reads the whole context. `calls` and `ctx` (shown when a turn made more than one call) give the estimated context of ONE call. Judge context size with `ctx`, never with `tokens`.
   - `CONTEXT_GROWTH` means an agent's context per call keeps growing round after round in a thread session: look for a static block repeated in every prompt.
4. **Token-Budgeted Context Protection**:
   - Never load raw full-thread timelines into an LLM agent context window.
   - Always use `--compact --json` (add `--flat` for single-line zero-whitespace JSON) combined with filters (`--last 1`, `--failures`, `--turn N`) to keep query payloads under 200 tokens.

---

## Quick Reference

| Task | Command | Typical Tokens |
|---|---|---|
| Check if any turn failed | `buzz-trace query <thread_id> --failures --compact --json` | ~80 tokens |
| Zero-whitespace minimal health check | `buzz-trace query <thread_id> --failures --compact --json --flat` | ~50 tokens |
| Adaptive context summary under budget | `buzz-trace context <thread_id> --budget <N> --flat` | $\le N$ tokens |
| Compare two agent turns / traces | `buzz-trace diff <trace1> <trace2> --flat` | ~120 tokens |
| Get latest turn status & tools | `buzz-trace query <thread_id> --last 1 --compact --json` | ~120 tokens |
| Inspect specific turn details | `buzz-trace query <thread_id> --turn <N> --tools --compact --json` | ~150 tokens |
| Filter by specific agent | `buzz-trace query <thread_id> --agent <agent_name> --compact --json` | ~150 tokens |
| Run automated diagnostics | `buzz-trace analyze <thread_id> --compact --json` | ~180 tokens |
| Thread cost and who answered whom | `buzz-trace query <thread_id> --compact --json --flat` (`cost_usd`, `parent`, `edge`, `candidates`) | ~250 tokens a turn; add `--last N` |
| Which turn posted message X, what each turn posted | `buzz-trace inspect <thread_id>` (`Reply To`, `Posted`), or `--json` (`parent_message`, `posts`) | Terminal UI |
| Messages steered into a running turn | `buzz-trace query <thread_id> --compact --json --flat` (`msgs`, `steered`, `steering`) | same |
| Phoenix with authentication on | `PHOENIX_API_KEY=…` (or `PHOENIX_EMAIL` + `PHOENIX_PASSWORD`) with `PHOENIX_URL=…` set | same |
| Full human-readable terminal view | `buzz-trace inspect <thread_id> [--project <community>]` | Terminal UI |
| Watch live thread execution | `buzz-trace watch <thread_id> [--interval 2.0]` | Interactive |
| List recent thread sessions | `buzz-trace sessions [--limit 10] [--project <community>]` | Terminal UI |

> [!NOTE]
> buzz-trace reads the Phoenix server named by `PHOENIX_ENDPOINT` or `PHOENIX_URL` (or `--endpoint`), and finds the project from the thread: no `--project` is needed. Pass `--project <community>` only to look in that project alone.

---

## Recipes for AI Agents & Self-Reflection

### 1. Check Thread Health & Failures (<100 tokens)

When reflecting on recent thread operations or checking if another agent ran into errors:

```bash
buzz-trace query <thread_id> --failures --compact --json --project <community>
```

**Output Shape:**
```json
{
  "thread_id": "5e06c7a86cfb158a1a89a96ec690ae5411d4633818a952a02a6f46ace0cd49e9",
  "status": "OK",
  "session_url": "http://localhost:6006/redirects/sessions/5e06c7a86cfb158a1a89a96ec690ae5411d4633818a952a02a6f46ace0cd49e9",
  "total_turns": 2,
  "filtered_turns": 0,
  "turns": []
}
```
*If `filtered_turns == 0` and `status == "OK"`, all turns succeeded with zero tool failures.*

---

### 2. Tail Recent Turn & Tool Executions (<150 tokens)

When verifying what the preceding agent executed before deciding next action:

```bash
buzz-trace query <thread_id> --last 1 --compact --json --project <community>
```

**Output Shape:**
```json
{
  "thread_id": "5e06c7a86cfb158a1a89a96ec690ae5411d4633818a952a02a6f46ace0cd49e9",
  "status": "OK",
  "session_url": "http://localhost:6006/redirects/sessions/5e06c7...",
  "total_turns": 2,
  "filtered_turns": 1,
  "turns": [
    {
      "turn": 2,
      "agent": "phoenix-twin",
      "parent": 1,
      "status": "OK",
      "dur_s": 32.0,
      "tokens": 79332,
      "calls": 3,
      "ctx": 26444,
      "trace_url": "http://localhost:6006/redirects/traces/237cdb2708d2f160c5174fdd8ed47086",
      "response": "Tôi đã thực hiện phép tính bằng Python...",
      "tools": [
        {
          "name": "run_command",
          "ok": true,
          "dur_ms": 25,
          "in": "{\"CommandLine\":\"python3 -c \\\"print(12345 * 6789)\\\"\"}"
        }
      ]
    }
  ]
}
```

---

### 3. Retrieve Direct Arize Phoenix Web UI Deep-Links

To point users or review artifacts to the exact Arize Phoenix dashboard:

- **Full Thread Session (All Turns & Gantt Waterfall):**
  Extracted directly from `session_url` in the query response:
  ```
  http://localhost:6006/redirects/sessions/<thread_id>
  ```
- **Single Turn Trace (Individual Span Tree):**
  Extracted directly from `trace_url` of turn `<N>`:
  ```
  http://localhost:6006/redirects/traces/<trace_id>
  ```
- Phoenix routes a project by its global id (`UHJvamVjdDoz` is `Project:3`), not by name, so these two redirect routes are the links that need no id. With authentication on, the page asks for a login first.

---

### 4. Anomaly Detection & Diagnostic Report

When an agent hangs, times out, or reports inconsistent outputs:

```bash
buzz-trace analyze <thread_id> --compact --json --project <community>
```

The analyzer checks for:
- `CLOCK_SKEW`: Span start timestamp preceded parent turn completion.
- `TIMEOUT_BREACH`: Turn duration exceeded timeout threshold.
- `ANOMALOUS_TOKEN_USAGE`: Prompt or completion token spikes (>90th percentile).
- `HIGH_TOOL_ERROR_RATE`: Non-zero tool error ratios.
- `DISCONNECTED_DAG`: Missing parent causality links in distributed threads.

---

### 5. Autonomous Metacognitive Feedback Loop (<150 tokens)

When an autonomous agent encounters tool or test execution failures, do NOT dump full conversation transcripts or raw trace trees into LLM context. Instead, run an ultra-targeted reflection loop:

1. **Query Failure Details**:
   ```bash
   buzz-trace query <thread_id> --failures --flat
   ```
   *Returns a single-line unindented JSON payload under 150 tokens containing only the failed turn, tool name, exit code, and error message.*

2. **Autonomous Remediation**:
   Extract `turn.tools[0].err` and `turn.tools[0].in`, diagnose the root cause, and apply corrective edits.

3. **Verify Health**:
   ```bash
   buzz-trace query <verify_thread_id> --failures --flat
   ```
   *Confirms `status == "OK"` and `filtered_turns == 0` in ~45 tokens, achieving 100% self-correction with >90% token savings.*

---

### 6. Differential Analysis of Agent Turns (`buzz-trace diff`)

When evaluating prompt variations, model upgrades (e.g. Gemini vs Claude), or analyzing performance regressions between turns:

```bash
# Compare two turns within a thread
buzz-trace diff <thread_id>#1 <thread_id>#2 --flat

# Or compare two distinct trace IDs
buzz-trace diff <trace_id_1> <trace_id_2> --flat
```

**Key AI Consumables:**
- `diff.model.changed`: Boolean indicating whether model was upgraded or changed.
- `diff.duration_ms.delta_ms`: Latency difference ($\Delta$ ms).
- `diff.tokens.total.delta_tokens`: Token consumption difference ($\Delta$ tok).
- `diff.tools.count.delta_count`: Difference in number of tool calls.
- `diff.tools.status_diff`: Detailed status transition per tool (e.g. `OK -> ERROR`).

---

### 7. Adaptive Context Summarizer Under Strict Budget (`buzz-trace context`)

When preparing context for an LLM agent prompt where context window tokens are strictly budgeted (e.g. 200 or 500 tokens):

```bash
buzz-trace context <thread_id> --budget 200 --flat
```

**Prioritization Hierarchy:**
1. **Root Intent**: Preserves Turn 1 prompt/inquiry to maintain user mission.
2. **Latest Turn Outcome**: Preserves final turn response and status to retain current state.
3. **Failed Tools & Errors**: Retains exact failing tool command and error diagnostics across the thread.
4. **Prunes Chatter**: Skips all intermediate routine successful turns.
5. **Token Cap Guarantee**: Automatically measures and adaptively trims fields so `actual_tokens <= budget`.

---

### 8. Who Answered Whom, and What It Cost (~250 tokens a turn)

```bash
buzz-trace query <thread_id> --compact --json --flat
```

Read `turns[].parent` (the turn it continues), `turns[].edge` (present only when the link is not exact), `turns[].candidates` (the turns that could have posted the parent message, when there is no `parent`), `cost_usd` (the thread, USD) and `turns[].ctx`. For one turn's full links use `inspect --json`: `event_id`, `reply_to` (the parent message), `parent_message` (`{ id, basis, posted_by_turn, turns }`; `basis` `annotation` is an exact link whose posted id came from a span annotation), `parent_edge`, `posts` (what the turn wrote to the thread: `event_id` when recorded, `event_id_source: "annotation"` when it came from an annotation, `reply_to`, `text`), `posted_event_ids`, and `tokens.cache_read`. Message ids in compact output are their first 8 hex (`parent_msg`, `posted_ids`); `inspect --json` has them whole.

### 9. Which Turn Posted This Message?

Ask for the thread (the id of any of its messages works) and read `Reply To` and `Posted` per turn:

```
Reply To : message 212193a2… posted by Turn 1 or Turn 2: not recorded, so no parent is picked
Posted   : id not recorded  "Kent Twin here…"
```

- `posted by Turn 1 (…)` with no qualifier: the reply span recorded the id. Exact.
- `posted by Turn 1 (…) — id from a span annotation` (and `Posted : 212193a2… (span annotation)`): the runtime did not record the id, but someone wrote it into Phoenix afterwards. Still exact. It says nothing about steering: such a trace still reads `steered messages are not recorded in this trace`.
- `— inferred: the only turn that could have posted it`: a deduction, not a record (it assumes an agent wrote the message, not a person).
- `Turn 1 or Turn 2: not recorded`: report both. Do not choose. To make it exact, the agent's runtime must write `nostr.posted_event_id` (64 hex) on the reply tool span, or return `event_id <hex>` in the tool's output. An old trace can be completed afterwards (below).

**Completing an old trace.** Whoever knows the ids (say, an operator who read them from the relay) writes one span annotation per reply span, named like the attribute. buzz-trace reads them (one request per 50 reply spans that record no id) and **never writes one**:

```jsonc
// POST /v1/span_annotations
{ "data": [ { "span_id": "bcf49f14a6f8f402",           // the reply span (16 hex)
              "name": "nostr.posted_event_id",
              "annotator_kind": "CODE",
              "identifier": "relay-backfill-v1",       // the same identifier again updates it
              "result": { "label": "<the 64-hex id of the message the call posted>", "explanation": "why you know it" },
              "metadata": { "source": "relay-backfill" } } ] }
```

The attribute wins over the annotation, and the annotation over `event_id <hex>` in the output text. Of several annotations on one span the latest counts; if its label is not a 64-hex id the span has none from annotations (an older one was replaced). A Phoenix without the route is read as having none.

### 10. Messages Steered Into a Running Turn

`Handled  : 4 messages (3 steered)` lists each steered message with its id and text (compact: `msgs`, `steered`). They are recorded as `steer` child spans (or span events); the text is the `Content:` line of the block the agent was handed. A line `↳ not delivered …` (compact: `not_delivered`) is a message the turn ended before receiving: it is not counted and not linked to, and nothing says that any turn ran it. `↳ more messages were steered … this list is not complete` means the runtime stopped writing steer spans for that turn.

`steered messages are not recorded in this trace` (compact: `steering: "not_recorded"`) appears only where nothing shows that the runtime writes them: a message that arrived while such a turn ran is simply absent, so "4 messages sent, 1 turn" is not a lost message. A turn whose runtime records posted ids reads plainly `Handled  : 1 message` when nothing was steered. A steered message that a reply call answered still shows in an older trace, marked `inferred from a reply call; text not recorded`.

### 11. A Thread Was Not Found

`status: "NOT_FOUND"` is an answer about the places that were searched, not about the thread. Read `tried`: it says which projects were looked in, and where the session is if it is in another project. If Phoenix answered 401 or 403, buzz-trace exits with code 2 and names `PHOENIX_API_KEY` and `PHOENIX_EMAIL`/`PHOENIX_PASSWORD`; it never reports that as `NOT_FOUND`. A sign-in lasts ten minutes on a default Phoenix; for repeated runs use an API key.

## Rationalization Table & Traps

| Temptation / Rationalization | Why It Fails | What To Do Instead |
|---|---|---|
| "I will run `buzz-trace inspect <id>` and parse everything myself." | Consumes 2,000+ tokens and clutters context window with ANSI escape codes and tables. | Use `buzz-trace query <id> --compact --json`. |
| "I only need `--compact`, no need for `--json`." | `--compact` is specifically a modifier for `--json` in structured rendering. Plain text ignores it. | Always pair them: `--compact --json`. |
| "Timestamps show Turn 2 started before Turn 1 finished, so the trace must be corrupted." | Distributed containers across hosts experience NTP clock jitter. | Trust the topological `reply_to` DAG built by `buzz-trace`, not wall-clock times. |
| "I can query Phoenix REST API directly with curl." | Raw Phoenix span tables contain unaggregated low-level OTel JSON requiring complex session stitching. | Let `buzz-trace` aggregate spans, compute DAGs, and format metrics. |
| "Command failed because project was not found." | A named `--project` that does not exist, or one the thread is not in. | Read `tried`: it lists the projects Phoenix has. Drop `--project` and buzz-trace finds the thread's project. |
| "`CONTEXT_GROWTH` means the conversation got long." | Read its message: if most of the growth is "re-sent with every prompt", the agent's harness repeats a static block in each message, whatever the conversation says. | Check the prompt the agent's harness builds, not the thread. |
| "`tokens` is 170k, so the context is nearly full." | `tokens` is summed over the turn's model calls; 3 calls of 57k read as 170k. | Read `ctx`. TOKEN_BLOAT and TOKEN_INFLATION already judge per call. |
| "`NOT_FOUND`, so the thread never ran." | It only says the places searched had nothing (a wrong `--endpoint`, a `--project` the thread is not in, spans not exported yet). | Read `tried`; check `PHOENIX_URL` and drop `--project`. |
| "`edge: inferred`, so the thread is unreliable." | It is only a link Phoenix cannot prove: no span records the id of the message the turn replies to. | Treat it as a deduction. The agent's runtime must record `nostr.posted_event_id` to make it exact. |
| "`edge: ambiguous` has no parent, so the turn is unrelated." | Several turns could have posted the parent message and buzz-trace will not pick one. | Use `candidates`; do not choose between them. |
| "No `edge` on a turn, so its parent is a guess." | The opposite: no `edge` is the exact link; `inferred` is the guess. | Check `candidates` and `edge` before relying on a parent. |
| "`Posted : … (span annotation)`, so the id is a guess." | It is an id someone wrote into Phoenix for that reply span; buzz-trace takes it exactly, and the link it gives is exact. It does not show that the runtime records steered messages. | Treat the link as exact and say where the id came from (`basis: "annotation"`). |
| "`Posted : id not recorded`, so the message was not posted." | The text and time of the reply call are in Phoenix; only the id of the message it created is not, unless the runtime records it. | Read the text of the post; the id needs `nostr.posted_event_id`. |
| "I sent 4 messages but see 3 turns, so one was lost." | With steering, a message sent while the agent is still answering is handled by the running turn and starts no trace. | Look for `Handled : N messages (K steered)` / `msgs` in compact output. If the report says steered messages are not recorded, the trace cannot show them. |
| "Two agents answered the same message, so one replied to the other." | They were started by the same message: siblings. | Trust `parent`, not the order of the turns. |

---

## Installing & Updating the Skill Globally

Install or symlink this skill into your AI agent environment:

```bash
# Automatic installation to ~/.claude/skills/buzz-trace and ~/.agents/skills/buzz-trace
buzz-trace install-skill

# Force overwrite existing installation
buzz-trace install-skill --force

# Preview actions without modifying filesystem
buzz-trace install-skill --dry-run
```
