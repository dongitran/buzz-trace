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
   - Edges have three strengths. No `edge` field in compact output means an exact `reply_to` link. `"edge":"inferred"` means the person answered an agent's own message, which no turn started from, so the parent is the latest finished turn. An `AMBIGUOUS_PARENT` anomaly names the other turns it could equally be. Agents started by one message are siblings, never parent and child.
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
| Thread cost and who answered whom | `buzz-trace query <thread_id> --compact --json --flat` (`cost_usd`, `parent`, `edge`) | ~200 tokens a turn (861 for a 4-turn thread); add `--last N` |
| Phoenix with authentication on | `PHOENIX_API_KEY=… buzz-trace query <thread_id> --project <community>` or `--db <copy of phoenix.db>` | same |
| Full human-readable terminal view | `buzz-trace inspect <thread_id> [--project <community>]` | Terminal UI |
| Watch live thread execution | `buzz-trace watch <thread_id> [--interval 2.0]` | Interactive |
| List recent thread sessions | `buzz-trace sessions [--limit 10] [--project <community>]` | Terminal UI |

> [!NOTE]
> The default project is `mobile`. For other communities (e.g., `agent-infra`, `zeusadm`, `simplemdg-v2`), specify `--project <community>`.

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
  "session_url": "http://localhost:6006/projects/mobile/sessions?selectedSessionId=5e06c7a86cfb158a1a89a96ec690ae5411d4633818a952a02a6f46ace0cd49e9",
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
  "session_url": "http://localhost:6006/projects/mobile/sessions?selectedSessionId=5e06c7...",
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
      "trace_url": "http://localhost:6006/projects/mobile/traces/237cdb2708d2f160c5174fdd8ed47086",
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
  http://localhost:6006/projects/<project>/sessions?selectedSessionId=<thread_id>
  ```
- **Single Turn Trace (Individual Span Tree):**
  Extracted directly from `trace_url` of turn `<N>`:
  ```
  http://localhost:6006/projects/<project>/traces/<trace_id>
  ```

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

### 8. Who Answered Whom, and What It Cost (~200 tokens a turn)

```bash
buzz-trace query <thread_id> --compact --json --flat --project <community>
```

Read `turns[].parent` (the turn it continues), `turns[].edge` (present only when the link is not exact), `cost_usd` (the thread, USD) and `turns[].ctx`. For one turn's full links use `inspect --json`: `event_id`, `reply_to`, `root_id`, `sender`, `parent_edge`, `posted` (what the turn wrote to the thread) and `tokens.cache_read`.

### 9. Make The Parent Links Exact

`"edge":"inferred"` or an `AMBIGUOUS_PARENT` anomaly means a person answered an agent's own message and Phoenix cannot say which turn wrote it. Give buzz-trace the relay's thread and every link becomes exact:

```bash
buzz messages thread --channel <channel_id> --event <thread_root_id> --format json > /tmp/thread.json
buzz-trace query <thread_root_id> --messages /tmp/thread.json --compact --json --flat --project <community>
```

The `source` of a full `inspect --json` then ends with `+ relay messages (N read, M linked)`. Times in Phoenix's SQLite are UTC; buzz-trace 0.3 reads them as UTC on any machine.

### 10. A Thread Was Not Found

`status: "NOT_FOUND"` is an answer about the places that were searched, not about the thread. Read `tried`: it lists each place with what it said, and the write time of a SQLite file. An auto-detected `~/.phoenix/phoenix.db` can be a stale copy made days ago. If Phoenix answered 401 or 403, buzz-trace exits with code 2 and names `PHOENIX_API_KEY` and `--db`.

## Rationalization Table & Traps

| Temptation / Rationalization | Why It Fails | What To Do Instead |
|---|---|---|
| "I will run `buzz-trace inspect <id>` and parse everything myself." | Consumes 2,000+ tokens and clutters context window with ANSI escape codes and tables. | Use `buzz-trace query <id> --compact --json`. |
| "I only need `--compact`, no need for `--json`." | `--compact` is specifically a modifier for `--json` in structured rendering. Plain text ignores it. | Always pair them: `--compact --json`. |
| "Timestamps show Turn 2 started before Turn 1 finished, so the trace must be corrupted." | Distributed containers across hosts experience NTP clock jitter. | Trust the topological `reply_to` DAG built by `buzz-trace`, not wall-clock times. |
| "I can query Phoenix REST API directly with curl." | Raw Phoenix span tables contain unaggregated low-level OTel JSON requiring complex session stitching. | Let `buzz-trace` aggregate spans, compute DAGs, and format metrics. |
| "Command failed because project was not found." | Default project is `mobile`. | Pass `--project <community>` matching the active Nostr community. |
| "`CONTEXT_GROWTH` means the conversation got long." | Read its message: if most of the growth is "re-sent with every prompt", the agent's harness repeats a static block in each message, whatever the conversation says. | Check the prompt the agent's harness builds, not the thread. |
| "`tokens` is 170k, so the context is nearly full." | `tokens` is summed over the turn's model calls; 3 calls of 57k read as 170k. | Read `ctx`. TOKEN_BLOAT and TOKEN_INFLATION already judge per call. |
| "`NOT_FOUND`, so the thread never ran." | It only says the places searched had nothing (a stale local copy, a wrong `--project`). | Read `tried`; pass `--db <live copy>` or `--project <community>`. |
| "`edge: inferred`, so the thread is unreliable." | It is only the one link that Phoenix cannot prove. | Pass `--messages` with the relay's thread: then every link is exact. |
| "No `edge` on a turn, so its parent is a guess." | The opposite: no `edge` is the exact link; `inferred` is the guess. | Check `AMBIGUOUS_PARENT` before relying on an inferred parent. |
| "I sent 4 messages but see 3 turns, so one was lost." | With steering, a message sent while the agent is still answering is handled by the running turn and starts no trace. | Look for `msgs: 2` in compact output (`steered_event_ids` in `inspect --json`): that turn handled both. |
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
