"""
Unit tests for ThreadAggregator.
"""

import unittest
from datetime import datetime, timezone
from buzz_trace.models import SpanNode
from buzz_trace.engine.aggregator import ThreadAggregator


class TestAggregator(unittest.TestCase):
    def test_thread_aggregator_multi_turn(self):
        spans = [
            # Turn 1
            SpanNode(
                span_id="s1",
                trace_id="t1",
                name="agent_turn",
                span_kind="AGENT",
                start_time=datetime(2026, 11, 1, 6, 11, 10, tzinfo=timezone.utc),
                end_time=datetime(2026, 11, 1, 6, 11, 20, tzinfo=timezone.utc),
                duration_ms=10000.0,
                status_code="OK",
                attributes={"session.id": "thread-123", "agent.name": "phoenix-twin"},
            ),
            SpanNode(
                span_id="s2",
                trace_id="t1",
                name="llm:gemini-3.8-flash-high",
                span_kind="LLM",
                parent_id="s1",
                attributes={
                    "llm.model_name": "gemini-3.8-flash-high",
                    "llm.token_count.prompt": 1000,
                    "llm.token_count.completion": 150,
                    "llm.token_count.total": 1150,
                },
            ),
            # Turn 2
            SpanNode(
                span_id="s3",
                trace_id="t2",
                name="agent_turn",
                span_kind="AGENT",
                start_time=datetime(2026, 11, 1, 6, 12, 0, tzinfo=timezone.utc),
                end_time=datetime(2026, 11, 1, 6, 12, 15, tzinfo=timezone.utc),
                duration_ms=15000.0,
                status_code="OK",
                attributes={"session.id": "thread-123", "agent.name": "paul-twin"},
            ),
            SpanNode(
                span_id="s4",
                trace_id="t2",
                name="tool:run_command",
                span_kind="TOOL",
                parent_id="s3",
                duration_ms=500.0,
                attributes={"tool.name": "run_command", "input.value": "echo hello", "tool.output_bytes": 10},
            ),
            SpanNode(
                span_id="s5",
                trace_id="t2",
                name="llm:gemini-3.8-flash-high",
                span_kind="LLM",
                parent_id="s3",
                attributes={
                    "llm.model_name": "gemini-3.8-flash-high",
                    "llm.token_count.prompt": 2000,
                    "llm.token_count.completion": 300,
                    "llm.token_count.total": 2300,
                },
            ),
        ]

        aggregator = ThreadAggregator(thread_id="thread-123", project="mobile")
        telemetry = aggregator.aggregate(spans)

        self.assertEqual(telemetry.thread_id, "thread-123")
        self.assertEqual(telemetry.total_turns, 2)
        self.assertEqual(telemetry.total_tokens, 3450)
        self.assertEqual(telemetry.total_prompt_tokens, 3000)
        self.assertEqual(telemetry.total_completion_tokens, 450)
        self.assertEqual(telemetry.status, "OK")

        # Check Turns ordering and data
        self.assertEqual(telemetry.turns[0].turn_index, 1)
        self.assertEqual(telemetry.turns[0].agent_name, "phoenix-twin")
        self.assertEqual(telemetry.turns[0].total_tokens, 1150)
        self.assertEqual(len(telemetry.turns[0].tools), 0)

        self.assertEqual(telemetry.turns[1].turn_index, 2)
        self.assertEqual(telemetry.turns[1].agent_name, "paul-twin")
        self.assertEqual(telemetry.turns[1].total_tokens, 2300)
        self.assertEqual(len(telemetry.turns[1].tools), 1)
        self.assertEqual(telemetry.turns[1].tools[0].name, "run_command")


if __name__ == "__main__":
    unittest.main()
