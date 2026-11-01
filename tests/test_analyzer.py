"""
Unit tests for AnomalyDetector.
"""

import unittest
from buzz_trace.models import AgentTurn, ThreadTelemetry, ToolExecution
from buzz_trace.engine.analyzer import AnomalyDetector


class TestAnalyzer(unittest.TestCase):
    def test_analyzer_context_canceled(self):
        turn = AgentTurn(
            turn_index=1,
            trace_id="tr-1",
            status_code="ERROR",
            status_message="context canceled during stream execution",
        )
        t = ThreadTelemetry(thread_id="th-1", project="mobile", turns=[turn])
        detector = AnomalyDetector()
        anomalies = detector.analyze(t)

        self.assertEqual(len(anomalies), 1)
        self.assertEqual(anomalies[0].type, "CONTEXT_CANCELED")
        self.assertEqual(anomalies[0].severity, "CRITICAL")

    def test_analyzer_tool_loop(self):
        tools = [
            ToolExecution(name="run_command", input_summary="grep foo bar.txt"),
            ToolExecution(name="run_command", input_summary="grep foo bar.txt"),
            ToolExecution(name="run_command", input_summary="grep foo bar.txt"),
        ]
        turn = AgentTurn(turn_index=1, trace_id="tr-2", tools=tools)
        t = ThreadTelemetry(thread_id="th-2", project="mobile", turns=[turn])
        detector = AnomalyDetector(tool_loop_threshold=3)
        anomalies = detector.analyze(t)

        self.assertTrue(any(a.type == "TOOL_LOOP" for a in anomalies))

    def test_analyzer_token_bloat(self):
        turn = AgentTurn(turn_index=1, trace_id="tr-3", prompt_tokens=180000, total_tokens=185000)
        t = ThreadTelemetry(thread_id="th-3", project="mobile", turns=[turn])
        detector = AnomalyDetector(token_bloat_threshold=150000)
        anomalies = detector.analyze(t)

        self.assertTrue(any(a.type == "TOKEN_BLOAT" for a in anomalies))


if __name__ == "__main__":
    unittest.main()
