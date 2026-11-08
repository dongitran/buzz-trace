# Changelog

All notable changes to `buzz-trace` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-08

Found by running buzz-trace against real multi-round and multi-agent Buzz threads of the `ba` community (one agent over
four rounds, a hand-off Kent → Ann → Kent → James, and one message that started two agents), scored against what was
actually sent: parent links were right for 4 of 11 turns, now 10 of 11, and the 11th is flagged as ambiguous.

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
