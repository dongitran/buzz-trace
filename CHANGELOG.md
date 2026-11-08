# Changelog

All notable changes to `buzz-trace` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-11-08

### Fixed
- **The links into the Phoenix UI did not open anything.** They were `/projects/<name>/sessions?selectedSessionId=<id>` and
  `/projects/<name>/traces/<id>`. Phoenix 21 routes a project by its global id (`UHJvamVjdDoz` is `Project:3`), not by name,
  and its UI has no `selectedSessionId` parameter. The thread link is now `/redirects/sessions/<session id>` and a turn's
  `/redirects/traces/<trace id>`: both routes exist in the UI and need no project id. Checked in the UI's own code (the
  pages need a login, so not by clicking).
- The test suite no longer depends on the machine it runs on: it runs with an empty `HOME` and none of the developer's `PHOENIX_*`
  variables (a test had found a real `~/.phoenix/phoenix.db` and passed or failed with it).

## [0.3.0] - 2026-11-08

Run on the four real ba threads (15 messages): parent links right for 14 of 15 from Phoenix alone, 15 of 15 with the
relay's thread.

### Added
- **`--messages <file>`** (`-` reads stdin): the relay's thread as `buzz messages thread --format json` prints it. Each reply
  call of a turn is matched to the relay message it created (same message answered, same moment, same words; one message
  per call), so the event id of everything a turn posted is known and every link is exact. No `AMBIGUOUS_PARENT` is left
  and no inference is needed. Optional: without it nothing changes.
- **`CONTEXT_GROWTH` says what the growth is made of**: per round, what the spans show (the turn's output, its tool
  results, the next message) and what they do not (`explainedPerRound`, `unexplainedPerRound`). When most of it is not
  in any span the message says it is re-sent with every prompt. On the ba twins it reported ~14.5k a round, and the
  agent's own session shows two static prompt blocks of about 15k tokens sent with every message.

### Fixed
- **Absolute times of spans read from Phoenix's SQLite were shifted by the machine's UTC offset.** Phoenix stores naive UTC
  (`2026-11-08 01:13:33.096000`); JavaScript read it as local time. Durations looked right (two shifted times subtract
  fine), so it went unseen on UTC machines; on a UTC+7 machine every `start_time`/`end_time` was 7 hours early and no
  comparison with another clock (the relay's) could work. A time without a zone is now UTC; one that names its zone is kept.

## [0.2.1] - 2026-11-08

### Fixed
- **Steered messages.** With `turn_handling: steer`, a message that arrives while an agent's turn is running is injected
  into that turn and starts no trace of its own: it looked like a missing turn, and a later reply to it could not be
  linked. The turn's `reply` calls name the messages they answered (`reply_to`), so those are read as
  `steered_event_ids` (full JSON), `msgs` (compact) and `Handled` (terminal), and a reply to one of them is an exact child
  of the turn that handled it. Seen live in ba `#consultant`: one turn of Ann answered two messages sent 12 s apart.
  Answers to the thread root, to the trigger's parent or to another turn's trigger are not counted as steering.
- `CONTEXT_GROWTH` (new in 0.2.0) was a WARNING, and `--failures` lists WARNINGs, so the cheapest health check returned a
  turn for a thread that had failed nothing. It is now INFO, and a WARNING only once the context per call is at least
  half the bloat threshold (75k by default).

## [0.2.0] - 2026-11-08

Found by running buzz-trace against real multi-round and multi-agent Buzz threads of the `ba` community (one agent over
four rounds, a hand-off Kent → Ann → Kent → James, and one message that started two agents), scored against what was
actually sent: parent links were right for 8 of 11 turns, now 10 of 11, and the 11th is flagged as ambiguous.

### Added
- **Buzz envelope reader** (`parseBuzzEnvelope`): turns' sender, the message the person wrote, its parent and thread root
  are read from the prompt buzz-acp hands the agent, so `prompt` shows the question, not `[Buzz event: @mention] Event ID: …`.
- **Honest thread edges**: `REPLY_TO` (exact), `INFERRED` (the person answered an agent's own message, which no turn
  started from: the parent is the latest finished turn of the thread), `THREAD_ROOT`. `AMBIGUOUS_PARENT` names the other
  turns an inferred parent could equally be. Dashed arrows in the Markdown diagram.
- **What each turn posted**: the text of the `reply`/`send` tool call is the turn's response (not the model's closing aside).
  `nostr.posted_event_id` on a span, when telemetry records it, makes the link exact.
- **Cost and cache**: `cost_usd` per turn and per thread (counted once), cache read/write tokens.
- **Context per model call** (`model_calls`, `context_per_call`, `calls`/`ctx` in compact): a turn's prompt tokens are
  summed over its model calls, so they are divided by the number of calls, estimated as tool steps + 1.
  Matched the harness's own count on 15 of 15 real turns. `diff` compares it too.
- **`CONTEXT_GROWTH` anomaly**: an agent whose context per call grows 2x and by 30k tokens over three or more turns.
- **`--api-key` / `PHOENIX_API_KEY`**: Bearer token for a Phoenix with authentication on.
- **Source reporting**: `source` of a found thread; `tried` (every place looked in, with the SQLite file's write time)
  for a thread that was not found.

### Fixed
- Agents started by the same message were chained as if one replied to the other (false `CLOCK_SKEW`).
- A reply to an agent's own message was attached to the thread root instead of the turn before it.
- `TOKEN_BLOAT` and `TOKEN_INFLATION` judged the summed tokens of a turn as if they were one context.
- A Phoenix that answered 401 was reported as `NOT_FOUND` with exit code 0; it is now an error (exit 2) that says what to set.
- A stale auto-detected `~/.phoenix/phoenix.db` was read silently; the source and its age are now reported.
- `sessions` listed other projects' sessions, always showed 0 tokens, and counted `--limit` in traces.
- `query` dropped cost, source and places tried when it filtered; Markdown section numbers skipped when there were no anomalies.

### Changed
- Compact JSON adds `parent`, `edge` (only when the link is not exact), `calls`/`ctx` (only with more than one call) and a
  thread-level `cost_usd`. Full JSON adds `event_id`, `reply_to`, `root_id`, `sender`, `parent_edge`, `posted`, `tokens.cache_*`.
- The Markdown timeline has Parent and Cost columns.

## [0.1.7] - 2026-11-01

### Added
- **`UNION` Covering Index Query Optimization**: Optimized SQLite span and trace resolution queries in `PhoenixDBClient` by using indexed `UNION` queries against `traces`, `project_sessions`, and `spans`, delivering up to a 15,000x speedup over unindexed full table scans.
- **Semantic Unescaped Tool Compactor**: Introduced `extractSemanticToolInput` in `src/formatters/compact-fmt.ts` to cleanly extract CLI command lines and arguments from stringified JSON inputs, eliminating the 2.77x JSON escaping penalty and achieving a 47% token reduction in tool argument payloads.
- **Cycle Guard in `assignBranches`**: Added cycle detection (`visited` set) in `assignBranches` recursion to eliminate potential stack overflow exceptions on cyclic or malformed trace graphs.
- **`INVALID_DURATION` Anomaly Detection & Clamping**: Added detection for monotonic clock jumps where span start time exceeds end time, automatically generating `INVALID_DURATION` warnings and clamping span/tool durations to non-negative 0ms values.
- **New CLI Flags `--tool-input` and `--cmd`**: Added precision filtering flags for `buzz-trace query` and `buzz-trace inspect` to filter agent turns by tool command lines, file paths, or arguments.

## [0.1.6] - 2026-11-01

### Added
- Token budget optimization with `--flat` unindented single-line JSON output mode.
- SQLite busy timeout handling (`PRAGMA busy_timeout = 5000`) for concurrent WAL readers.
- `CAUSAL_OVERLAP` anomaly detection for overlapping parent-child turn executions.

## [0.1.5] - 2026-11-01

### Added
- Cross-platform AI skill installation CLI command (`buzz-trace install-skill`).
- Automatic symlink & directory integration for Claude Code (`~/.claude/skills`) and Agent runtimes (`~/.agents/skills`).

## [0.1.4] - 2026-11-01

### Added
- Metacognitive query engine (`buzz-trace query`).
- Phoenix Web UI deep linking (`--ui-endpoint`).
- Causal execution DAG analysis with Kahn's topological sorting algorithm.

## [0.1.3] - 2026-11-01

### Added
- Multi-identifier thread resolution supporting Nostr root event IDs, trace IDs, and session IDs.

## [0.1.2] - 2026-11-01

### Added
- Automated anomaly detection for context cancellations, tool error loops, and token bloat.

## [0.1.0] - 2026-11-01

### Added
- Initial TypeScript and ESM port of `buzz-trace`.
- Direct Arize Phoenix SQLite mode and REST API client.
