"""
Unit tests for data models.
"""

import unittest
from datetime import datetime, timezone
from buzz_trace.models import SpanNode, ToolExecution, AgentTurn, ThreadTelemetry, Anomaly


class TestModels(unittest.TestCase):
    def test_span_node_from_dict(self):
        raw_data = {
            "context": {"span_id": "span-123", "trace_id": "trace-456"},
            "name": "agent_turn",
            "span_kind": "AGENT",
            "start_time": "2026-11-01T06:11:12.823000Z",
            "end_time": "2026-11-01T06:11:15.823000Z",
            "status_code": "OK",
            "attributes": {"session.id": "thread-root-1"},
        }
        node = SpanNode.from_dict(raw_data)
        self.assertEqual(node.span_id, "span-123")
        self.assertEqual(node.trace_id, "trace-456")
        self.assertEqual(node.name, "agent_turn")
        self.assertEqual(node.status_code, "OK")
        self.assertEqual(node.duration_ms, 3000.0)
        self.assertEqual(node.attributes.get("session.id"), "thread-root-1")

    def test_thread_telemetry_to_dict(self):
        t = ThreadTelemetry(
            thread_id="root-1",
            project="mobile",
            session_id="sess-1",
            total_turns=1,
            total_tokens=1000,
            total_prompt_tokens=800,
            total_completion_tokens=200,
            total_duration_ms=5000.0,
            status="OK",
            turns=[
                AgentTurn(
                    turn_index=1,
                    trace_id="tr-1",
                    agent_name="phoenix-twin",
                    model_name="gemini-3.8-flash-high",
                    duration_ms=5000.0,
                    prompt_tokens=800,
                    completion_tokens=200,
                    total_tokens=1000,
                    status_code="OK",
                    tools=[
                        ToolExecution(name="run_command", duration_ms=400.0, status_code="OK", input_summary="ls")
                    ],
                )
            ],
            anomalies=[
                Anomaly(type="LATENCY_SPIKE", severity="INFO", message="Slow", turn_index=1, trace_id="tr-1")
            ],
        )
        d = t.to_dict()
        self.assertEqual(d["thread_id"], "root-1")
        self.assertEqual(d["total_tokens"], 1000)
        self.assertEqual(len(d["turns"]), 1)
        self.assertEqual(d["turns"][0]["agent"], "phoenix-twin")
        self.assertEqual(len(d["anomalies"]), 1)


if __name__ == "__main__":
    unittest.main()
