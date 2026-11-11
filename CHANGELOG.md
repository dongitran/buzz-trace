# Changelog

All notable changes to `buzz-trace` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-11

`inspect` and `query` keep 80 characters of a tool's input and never read what the tool returned, so a conversation (a huddle, a
long run of tool calls) could not be read from them. Phoenix holds all of it: a tool span carries the whole `input.value` and
`output.value` its runtime recorded. buzz-trace now shows it, whole, in the order it ran. Read live: a 25-minute huddle of two
turns, 134 tool calls, 59 things a person said.

### Added
- **`buzz-trace transcript <thread_id>`**: for each turn, the message that started it, then every step in the order it ran with its
  whole request and whole response (a tool call, the words the model wrote, a steered message), and the text the turn ended with.
  A tool call says how it ended, how long it took and which model call asked for it (`tool.call_id` matched to the model call's
  `llm.output_messages…tool_calls`). Terminal, Markdown (`--markdown`) and JSON (`--json`, `--flat`) forms. JSON requests and
  responses are the JSON value when the recorded text is JSON, else the text, else `null`.
- **`--dialogue`**: only the conversation, in order. The message that started each turn and the steered ones, what the agent posted
  to the thread and, in a huddle, what people said (`meeting_wait` `heard[]`: speaker, text, offset into the call, why it reached the
  agent) and what the agent said (`meeting_speak`) with what became of it: `complete`, `interrupted` (by whom, and the part that was
  spoken), `not_spoken`, `async`, or `unknown` with the gate's own answer kept.
- **Filters**: `--turn`, `--last`, `--agent` (as in `query`); `--tool a,b` (steps of these tools, a part of a name is enough) and
  `--failures` (failed steps). A step keeps the number it has in the whole turn. `--verbose` adds a line per model call and the whole
  prompt. `--dialogue` refuses `--tool` and `--failures`, and `transcript` refuses `--tool-input`, `--turn abc` and `--last 0`
  before Phoenix is asked: an answer to another question would look like the answer.
- The transcript reads a thread with the requests the other commands make, and none more.

### Rules
- **Where the telemetry holds less than happened, the transcript says so.** A runtime may record only the start of a long output:
  when `tool.output_bytes` is more than the bytes recorded, the step reads `response cut by the runtime: recorded 8,207 of 12,098
  bytes` (`response_truncated`, `response_recorded_bytes`, `response_returned_bytes`). Six `knowledge_search` responses of the live
  huddle were cut this way.
- **A turn with no `agent_turn` span** (the process ended before the span did) has its model and tool spans but no root: the
  transcript gives `root_span: false`, `agent: null`, no closing text, and the times of the spans seen. `inspect` and `query`
  keep calling such a turn `phoenix-twin`, which is only their default.
- A message that started two turns (a restart) is listed under both and says `same message as turn N`. A call that failed said
  nothing, and a steered message the turn ended before receiving was not part of its conversation: neither is in the dialogue.
- **Text is shown, not obeyed.** Recorded text can hold escape sequences that clear a screen or set a window title. The terminal and
  Markdown forms show control characters and text-reordering characters as escapes (`\x1b`, `\u202e`) and read any line break as a
  line break; the JSON form keeps the exact text.
- The transcript is not token-budgeted. Narrow it before giving it to a model (README, skill).

### Changed
- `isToolCall`, `toolNameOf`, `findRootSpan` and `agentNameOf` are exported from the aggregator, so that the transcript applies the
  rules the other commands apply. No change of behaviour.

## [0.4.2] - 2026-11-08

A trace written before a runtime recorded `nostr.posted_event_id` holds no id for a posted message, and a span cannot be edited.
Phoenix can hold a span annotation on it, though. buzz-trace now reads the id from one, so an old thread can be completed from
inside Phoenix and shown exactly: the thread `fb46eb2a…` shows message `212193a2…` posted by Turn 1.

### Added
- **The posted id from a span annotation.** After a thread's spans are read, buzz-trace asks Phoenix for the annotations named
  `nostr.posted_event_id` on the reply calls whose span records no id (`GET /v1/projects/{project}/span_annotations`, `span_ids`
  repeated, 50 spans a request, `include_annotation_names=nostr.posted_event_id`, the cursor followed). The `result.label`, when it
  is a 64-hex id, counts exactly as the attribute would. Nothing is asked when there is no such call. buzz-trace only reads: it
  makes no request but GET, and never writes an annotation.
- **How to complete a trace** (README, skill): one annotation per reply span, `POST /v1/span_annotations`, `name`
  `nostr.posted_event_id`, `annotator_kind` `CODE`, an `identifier` (the same one again updates it), `result.label` the 64-hex id,
  `result.explanation` why it is known, `metadata`.
- **The report says where the id came from.** `parent_message.basis` is `annotation` (an exact link, `REPLY_TO`); a post read from an
  annotation has `event_id_source: "annotation"`; compact output has `parent_basis: "annotation"`. The terminal reads
  `Reply To : message 212193a2… posted by Turn 1 (ba-kent-twin) — id from a span annotation` and `Posted   : 212193a2… (span annotation)`;
  the Markdown says `(annotation)`. A thread whose runtime recorded the ids reads, and serializes, exactly as before.

### Rules
- **Which id wins**: the attribute, then the annotation, then `event_id <hex>` in the output text.
- **Several annotations on a span**: the latest (`updated_at`, else `created_at`) counts. If its label is not a 64-hex id the span
  has none from annotations: an older one was replaced and is not used. Equally new annotations that name different ids give none.
- **An annotation is not evidence about steering.** It was written afterwards, so a trace completed this way still reads
  `steered messages are not recorded in this trace`; only an id the runtime recorded counts as a sign that it writes steer spans.
- A Phoenix that answers 404 for the annotations (no such route) is read as having none; any other failure is an error.

### Changed
- A thread whose reply spans lack an id costs one more request per 50 such spans (a thread whose project is found first: five
  requests, not four). The message of the `AMBIGUOUS_PARENT` anomaly says an id can also be written as an annotation.

## [0.4.1] - 2026-11-08

The Buzz fork now writes `steer` spans and posted ids on the four ba twins, and its authors read 0.4.0 against live threads. Four
things were wrong or missing in how buzz-trace reads what the fork writes.

### Fixed
- **The text of a steered message was the whole block the agent was handed** (`[New message — arrived while you were working]
  [Buzz event: @mention] Event ID: …`). The span's `input.value` is that block; the message is the envelope's `Content:` line.
  The report, the Markdown and the JSON now show that line (a plain text, as other runtimes may record, is read as before). The
  id comes from the block when the span has no `nostr.event_id`; the sender is the span's `nostr.sender_name`, else a real name
  in the block (an npub is not shown as a name), and `nostr.sender_pubkey` goes into the JSON.
- **"steered messages are not recorded in this trace" was printed for traces whose runtime does record them** and simply had
  nothing steered. It now appears only for a turn with no sign that its runtime writes the contract: no `steer` record, no
  recorded posted id (a runtime that writes ids writes steer spans), and no such turn of the same agent in the thread. `steering`
  in the JSON follows (`recorded` when a steered message would show), and each turn has `steering_recorded`. Traces written
  before the contract read as they did.
- **A filtered query lost the thread's steering state**: `--last`, `--turn`, `--agent`, `--failures` and the other filters said
  `steering: "not_recorded"` for a thread that had recorded steering.

### Added
- **`steer.delivered`**: false means the turn ended before the message was echoed to it or a result named it. Nothing says that any
  turn ran such a message (it may run inside a later one, or never), so it is listed as `↳ not delivered …`, is not counted in
  `Handled N messages`, and a later reply to it is not linked to the turn. In the JSON `steered[]` has `delivered` and
  `end_reason` (`echo`, `result`, `turn_end`); compact output lists them apart as `not_delivered`.
- **`steer_spans_capped`**: the runtime stops writing steer spans for a turn after a number of them, and says so with this event.
  The report, the Markdown and the JSON (`steered_capped`) say that the list is not complete.

### Changed
- An id that a `steer` record shows was sent to a turn is never looked for among the turns' own reply calls (a message sent to a
  turn was not created by one), so a reply to it is no longer attributed to an agent by inference.

## [0.4.0] - 2026-11-08

**Breaking: Phoenix's server is now the only source.** buzz-trace reads Phoenix over its API and nothing else: no relay file, no
`buzz` CLI, no database file. It also answers, honestly, which turn posted a message and which messages a turn handled.

### Removed (breaking)
- **`--messages <file>`** and everything behind it (the join with the relay's thread, `Config.messagesPath`,
  `ThreadTelemetry.relayMessages`). Passing it is an argument error. What it did is now done from Phoenix alone, exactly where
  the agent's runtime records the id of what it posted (see "Telemetry contract" in the README).
- **`--db <phoenix.db>`**, `PHOENIX_DB_PATH`, the auto-detected `~/.phoenix/phoenix.db` and the `node:sqlite` reader
  (`PhoenixDBClient`). `--db` now stops with: `--db was removed in 0.4.0: buzz-trace reads the Phoenix server. Set
  PHOENIX_ENDPOINT (or PHOENIX_URL), or pass --endpoint.` **Migration:** for an offline copy of Phoenix's file, start a local Phoenix
  on it (`PHOENIX_WORKING_DIR=<folder holding phoenix.db> phoenix serve`) and point `--endpoint` at that.
- **The default project `mobile`.** With no `--project` and no `PHOENIX_PROJECT`, buzz-trace asks Phoenix which project holds the
  thread (`GET /v1/sessions/{id}`) and, for an id that is not a session, searches every project. `Config.project` is `null`
  until then, and `project` in the JSON is the project the thread was found in.

### Added
- **Signing in.** `--api-key` / `PHOENIX_API_KEY` is sent as a Bearer token. Without a key, `PHOENIX_EMAIL` and
  `PHOENIX_PASSWORD` sign in (`POST /auth/login`) and the access token is sent as Bearer; a request that is refused refreshes
  the session (`POST /auth/refresh`, whose refresh token rotates) or signs in again, once. A key that Phoenix rejects gives way to
  the email and password when both are set. A command signs in once (`diff` and `watch` share the session). No credential is printed,
  put in a URL or left in an error (errors are redacted; a `Config` or client cannot be printed with its credentials), and the
  password and email are read from the environment only. A 429 on sign-in says so and points to an API key.
- **`PHOENIX_URL`** as an endpoint (after `--endpoint` and `PHOENIX_ENDPOINT`).
- **Which turn posted a message.** `Reply To : message 212193a2… posted by Turn 1 (ba-kent-twin)` and, per turn,
  `Posted   : 5724e661…  "text"`. The contract is `nostr.posted_event_id` on the reply tool span, or `event_id <64 hex>` in
  that span's `output.value` or `tool.output`; all names are constants of `src/contract.ts`. JSON: `posted_event_ids`, `posts[]`,
  `answered_event_ids`, `parent_message { id, basis, posted_by_turn, turns }`. Compact: `parent_msg`, `posted_ids`.
- **Steered messages.** A child span named `steer` under the turn's `agent_turn` span (or a span event of that name) with
  `nostr.event_id`, `input.value`, `nostr.sender_name` and `steer.priority` is read as a message injected into the running turn:
  `Handled  : 4 messages (3 steered)` with each id and text (JSON `handled_messages`, `steered[]`; compact `msgs`, `steered`).
  Where nothing recorded them the report says `steered messages are not recorded in this trace` (`steering: "not_recorded"`), and
  a steered message that a reply call answered is still shown, marked as inferred.
- **Message ids can find a thread**: the id of a message that started a turn, that a turn replied to, or that a reply span
  recorded as posted, as well as a trace id.
- Markdown: a "Message links" table (started by, replies to, who posted the parent, what the turn posted) and dashed
  possible-parent edges.

### Changed
- **A parent message that no span names is no longer given to "the latest turn that had finished".** Reading real threads
  against the relay's own record showed that guess wrong exactly when two agents answered one message together (the ba thread
  `fb46eb2a…`: turn 3 answers a message turn 1 posted; 0.3.1 said turn 2, flagged `INFERRED`). Now the turns whose reply calls
  could have created that message are worked out (a call that started before the answering turn, did not fail, did not answer
  that message, and is not needed for another message, since one call creates one message). One turn left: `INFERRED`, with the
  reason. Several: `AMBIGUOUS` with `parent_candidates` and **no parent picked**; the `AMBIGUOUS_PARENT` anomaly names them. On the
  five real ba threads (7 such links), 5 were inferred, all right, and 2 were ambiguous with the right turn among the candidates;
  none was wrong. Edge `parent_alternatives` stays, as a copy of `parent_candidates`.
- A turn that replies to the thread's root, or to a message nobody could have posted, is linked by `THREAD_ROOT` (or not at all)
  rather than inferred.
- `sessions` lists the newest sessions first, of every project unless one is named (each line names its project).
- The default request timeout is 30 s (a page can be 1,000 spans).
- A time without a zone is still read as UTC, whatever the machine's zone; Phoenix's API names the zone of every time.

### Fixed
- **A thread of more than 100 spans was cut off without a word.** Phoenix's span listing gives 100 by default and a cursor for
  the rest, and the client read the first page only. It asks for 1,000 and follows `next_cursor`.
- Phoenix's REST API lists spans newest first, so a turn's tools were listed in reverse order (and tool-loop detection read them
  backwards). Spans are requested, and sorted, by start time.
- `sessions` listed the oldest sessions first.
- A trace's spans that do not carry `session.id` (a steer record, for one) are read with the rest of the trace.

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
