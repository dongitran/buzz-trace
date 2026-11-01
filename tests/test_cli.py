"""
Unit tests for CLI parsing and formatters.
"""

import io
import sys
import unittest
from unittest.mock import patch
from src.cli import build_parser, main
from src.models import ThreadTelemetry, AgentTurn


class TestCLI(unittest.TestCase):
    def test_cli_parser_version(self):
        parser = build_parser()
        args = parser.parse_args(["inspect", "root-123", "--project", "test-proj", "--json"])
        self.assertEqual(args.command, "inspect")
        self.assertEqual(args.thread_id, "root-123")
        self.assertEqual(args.project, "test-proj")
        self.assertTrue(args.json)

    def test_cli_inspect_mocked(self):
        mock_telemetry = ThreadTelemetry(
            thread_id="test-root-event",
            project="mobile",
            total_turns=1,
            total_tokens=500,
            status="OK",
            turns=[
                AgentTurn(
                    turn_index=1,
                    trace_id="tr-test",
                    agent_name="phoenix-twin",
                    model_name="gemini-3.8-flash-high",
                    total_tokens=500,
                    status_code="OK",
                )
            ],
        )

        with patch("src.cli.fetch_thread_telemetry", return_value=mock_telemetry):
            buf = io.StringIO()
            with patch.object(sys, "stdout", buf):
                ret = main(["inspect", "test-root-event", "--no-color"])
                self.assertEqual(ret, 0)
                out = buf.getvalue()
                self.assertIn("BUZZ-TRACE", out)
                self.assertIn("test-root-event", out)
                self.assertIn("phoenix-twin", out)


if __name__ == "__main__":
    unittest.main()
