"""
CLI entry point for buzz-trace.
"""

import argparse
import sys
import time
from typing import List

from .clients.phoenix_api import PhoenixAPIError, PhoenixClient
from .clients.phoenix_db import PhoenixDBClient
from .config import Config
from .engine.aggregator import ThreadAggregator
from .engine.analyzer import AnomalyDetector
from .formatters.json_fmt import JsonRenderer
from .formatters.markdown import MarkdownRenderer
from .formatters.terminal import TerminalRenderer
from .models import SpanNode, ThreadTelemetry


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="buzz-trace",
        description="Distributed Thread Observability & Diagnostic CLI for Multi-Agent Nostr Networks",
    )
    parser.add_argument("--version", action="version", version="%(prog)s 0.1.0")

    subparsers = parser.add_subparsers(dest="command", help="Sub-commands")

    # Command: inspect
    inspect_parser = subparsers.add_parser("inspect", help="Inspect telemetry for a Nostr thread ID")
    inspect_parser.add_argument("thread_id", help="Root event ID of the Nostr thread")
    _add_common_options(inspect_parser)

    # Command: analyze
    analyze_parser = subparsers.add_parser("analyze", help="Perform automated diagnostic & anomaly detection on a thread")
    analyze_parser.add_argument("thread_id", help="Root event ID of the Nostr thread")
    _add_common_options(analyze_parser)

    # Command: sessions
    sessions_parser = subparsers.add_parser("sessions", help="List recent active sessions and thread traces")
    sessions_parser.add_argument("--limit", type=int, default=10, help="Number of sessions to display (default: 10)")
    _add_connection_options(sessions_parser)

    # Command: watch
    watch_parser = subparsers.add_parser("watch", help="Live monitor a thread execution in real-time")
    watch_parser.add_argument("thread_id", help="Root event ID of the Nostr thread")
    watch_parser.add_argument("--interval", type=float, default=2.0, help="Polling interval in seconds (default: 2.0)")
    _add_common_options(watch_parser)

    return parser


def _add_connection_options(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--endpoint",
        type=str,
        default=None,
        help="Arize Phoenix server endpoint (default: http://localhost:6006 or env PHOENIX_ENDPOINT)",
    )
    p.add_argument(
        "--project",
        type=str,
        default=None,
        help="Arize Phoenix project name (default: mobile or env PHOENIX_PROJECT)",
    )
    p.add_argument(
        "--db",
        type=str,
        default=None,
        help="Direct path to Phoenix SQLite database file (mode=ro)",
    )


def _add_common_options(p: argparse.ArgumentParser) -> None:
    _add_connection_options(p)
    p.add_argument("--json", action="store_true", help="Output AI-optimized JSON")
    p.add_argument("--markdown", action="store_true", help="Output GitHub/GitLab Markdown report")
    p.add_argument("--verbose", "-v", action="store_true", help="Include verbose details (I/O previews)")
    p.add_argument("--no-color", action="store_true", help="Disable ANSI color codes")


def fetch_thread_telemetry(config: Config, thread_id: str) -> ThreadTelemetry:
    spans: List[SpanNode] = []

    # 1. Direct DB mode if configured
    if config.db_path:
        db_client = PhoenixDBClient(config.db_path)
        spans = db_client.get_spans_for_thread(thread_id)
    else:
        # 2. REST API mode
        api_client = PhoenixClient(endpoint=config.endpoint, timeout=config.timeout)
        spans = api_client.get_spans_for_thread(config.project, thread_id)

    aggregator = ThreadAggregator(thread_id=thread_id, project=config.project)
    telemetry = aggregator.aggregate(spans)

    analyzer = AnomalyDetector()
    analyzer.analyze(telemetry)

    return telemetry


def run_inspect(args: argparse.Namespace, config: Config) -> int:
    try:
        telemetry = fetch_thread_telemetry(config, args.thread_id)
    except PhoenixAPIError as e:
        sys.stderr.write(f"Error: {e}\n")
        return 2
    except Exception as e:
        sys.stderr.write(f"Unexpected error: {e}\n")
        return 1

    if args.json:
        renderer = JsonRenderer()
        print(renderer.render(telemetry))
    elif args.markdown:
        renderer = MarkdownRenderer()
        print(renderer.render(telemetry))
    else:
        renderer = TerminalRenderer(use_colors=not args.no_color)
        print(renderer.render(telemetry, verbose=args.verbose))

    return 0


def run_analyze(args: argparse.Namespace, config: Config) -> int:
    try:
        telemetry = fetch_thread_telemetry(config, args.thread_id)
    except Exception as e:
        sys.stderr.write(f"Error: {e}\n")
        return 2

    if args.json:
        renderer = JsonRenderer()
        print(renderer.render(telemetry))
    elif args.markdown:
        renderer = MarkdownRenderer()
        print(renderer.render(telemetry))
    else:
        renderer = TerminalRenderer(use_colors=not args.no_color)
        print(renderer.render(telemetry, verbose=True))

    # Exit with code 1 if critical anomalies exist
    has_critical = any(a.severity == "CRITICAL" for a in telemetry.anomalies)
    return 1 if has_critical else 0


def run_sessions(args: argparse.Namespace, config: Config) -> int:
    try:
        api_client = PhoenixClient(endpoint=config.endpoint, timeout=config.timeout)
        sessions = api_client.list_sessions(config.project, limit=args.limit)
    except Exception as e:
        sys.stderr.write(f"Error fetching sessions: {e}\n")
        return 2

    print(f"Arize Phoenix Sessions · Project: {config.project} (Limit: {args.limit})")
    print("=" * 80)
    if not sessions:
        print("No sessions found.")
        return 0

    for idx, s in enumerate(sessions, start=1):
        sid = s.get("session_id") or s.get("id")
        traces = s.get("traces", [])
        tokens = s.get("token_count_total", 0)
        start = s.get("start_time", "N/A")
        print(f"[{idx:02d}] Session: {sid} · Traces: {len(traces)} · Tokens: {tokens:,} · Started: {start}")
        for t in traces[:3]:
            print(f"     ├── Trace: {t.get('trace_id')}")
        if len(traces) > 3:
            print(f"     └── ... ({len(traces) - 3} more traces)")
        print("-" * 80)

    return 0


def run_watch(args: argparse.Namespace, config: Config) -> int:
    last_turns_count = -1
    print(f"Live monitoring thread: {args.thread_id} (polling every {args.interval}s)... Press Ctrl+C to exit.\n")
    try:
        while True:
            try:
                telemetry = fetch_thread_telemetry(config, args.thread_id)
                if len(telemetry.turns) != last_turns_count:
                    # Clear screen and re-render
                    sys.stdout.write("\033[2J\033[H")
                    sys.stdout.flush()
                    renderer = TerminalRenderer(use_colors=not args.no_color)
                    print(renderer.render(telemetry, verbose=args.verbose))
                    last_turns_count = len(telemetry.turns)
            except Exception as e:
                sys.stderr.write(f"Transient error: {e}\n")

            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nMonitoring stopped.")
        return 0


def main(argv: List[str] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return 0

    config = Config.load(
        endpoint=getattr(args, "endpoint", None),
        project=getattr(args, "project", None),
        db_path=getattr(args, "db", None),
    )

    if args.command == "inspect":
        return run_inspect(args, config)
    elif args.command == "analyze":
        return run_analyze(args, config)
    elif args.command == "sessions":
        return run_sessions(args, config)
    elif args.command == "watch":
        return run_watch(args, config)

    return 0


if __name__ == "__main__":
    sys.exit(main())
