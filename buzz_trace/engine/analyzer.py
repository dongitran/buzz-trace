"""
Analytical intelligence and automated anomaly detector for thread telemetry.
"""

from typing import List

from ..models import Anomaly, ThreadTelemetry


class AnomalyDetector:
    def __init__(
        self,
        token_bloat_threshold: int = 150000,
        slow_turn_ms: float = 60000.0,
        tool_loop_threshold: int = 3,
    ):
        self.token_bloat_threshold = token_bloat_threshold
        self.slow_turn_ms = slow_turn_ms
        self.tool_loop_threshold = tool_loop_threshold

    def analyze(self, telemetry: ThreadTelemetry) -> List[Anomaly]:
        anomalies: List[Anomaly] = []

        for turn in telemetry.turns:
            # 1. Check for Context Canceled
            msg = (turn.status_message or "").lower()
            if "context canceled" in msg or "canceled" in msg or "aborted" in msg:
                anomalies.append(
                    Anomaly(
                        type="CONTEXT_CANCELED",
                        severity="CRITICAL",
                        message=f"Turn {turn.turn_index} was prematurely aborted with context cancellation.",
                        turn_index=turn.turn_index,
                        trace_id=turn.trace_id,
                        details={"status_message": turn.status_message},
                    )
                )

            # 2. Check for Tool Errors
            for tool in turn.tools:
                if tool.status_code == "ERROR" or tool.error:
                    anomalies.append(
                        Anomaly(
                            type="TOOL_ERROR",
                            severity="WARNING",
                            message=f"Tool '{tool.name}' failed in Turn {turn.turn_index}: {tool.error or 'Non-zero status'}",
                            turn_index=turn.turn_index,
                            trace_id=turn.trace_id,
                            details={"tool_name": tool.name, "error": tool.error},
                        )
                    )

            # 3. Check for Tool Loops (repeating identical tool calls)
            if len(turn.tools) >= self.tool_loop_threshold:
                consecutive = 1
                for i in range(1, len(turn.tools)):
                    prev = turn.tools[i - 1]
                    curr = turn.tools[i]
                    if prev.name == curr.name and prev.input_summary == curr.input_summary and curr.input_summary:
                        consecutive += 1
                        if consecutive >= self.tool_loop_threshold:
                            anomalies.append(
                                Anomaly(
                                    type="TOOL_LOOP",
                                    severity="CRITICAL",
                                    message=f"Tool loop detected: '{curr.name}' invoked {consecutive} times with identical arguments in Turn {turn.turn_index}.",
                                    turn_index=turn.turn_index,
                                    trace_id=turn.trace_id,
                                    details={"tool_name": curr.name, "count": consecutive},
                                )
                            )
                            break
                    else:
                        consecutive = 1

            # 4. Check for Token Bloat
            if turn.prompt_tokens >= self.token_bloat_threshold:
                anomalies.append(
                    Anomaly(
                        type="TOKEN_BLOAT",
                        severity="WARNING",
                        message=f"Excessive prompt context in Turn {turn.turn_index}: {turn.prompt_tokens:,} tokens (threshold: {self.token_bloat_threshold:,}).",
                        turn_index=turn.turn_index,
                        trace_id=turn.trace_id,
                        details={"prompt_tokens": turn.prompt_tokens},
                    )
                )

            # 5. Check for Latency Spikes
            if turn.duration_ms >= self.slow_turn_ms:
                anomalies.append(
                    Anomaly(
                        type="LATENCY_SPIKE",
                        severity="INFO",
                        message=f"Slow turn execution: Turn {turn.turn_index} took {turn.duration_ms / 1000.0:.1f}s (threshold: {self.slow_turn_ms / 1000.0:.0f}s).",
                        turn_index=turn.turn_index,
                        trace_id=turn.trace_id,
                        details={"duration_ms": turn.duration_ms},
                    )
                )

        telemetry.anomalies = anomalies
        return anomalies
