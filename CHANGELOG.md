# Changelog

All notable changes to `buzz-trace` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
