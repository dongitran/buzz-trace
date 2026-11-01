"""
Data models for thread telemetry, traces, spans, and analytical anomalies.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass
class SpanNode:
    span_id: str
    trace_id: str
    name: str
    span_kind: str
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration_ms: float = 0.0
    parent_id: Optional[str] = None
    status_code: str = "OK"  # OK, ERROR, UNSET
    status_message: Optional[str] = None
    attributes: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SpanNode":
        # Extract context or id
        context = data.get("context", {})
        span_id = context.get("span_id") or data.get("span_id") or data.get("id") or ""
        trace_id = context.get("trace_id") or data.get("trace_id") or ""
        parent_id = data.get("parent_id")

        name = data.get("name", "unknown_span")
        span_kind = data.get("span_kind", "SPAN_KIND_INTERNAL")

        # Parse times
        st = data.get("start_time")
        et = data.get("end_time")
        start_dt = None
        end_dt = None
        if isinstance(st, str):
            try:
                start_dt = datetime.fromisoformat(st.replace("Z", "+00:00"))
            except Exception:
                pass
        elif isinstance(st, datetime):
            start_dt = st

        if isinstance(et, str):
            try:
                end_dt = datetime.fromisoformat(et.replace("Z", "+00:00"))
            except Exception:
                pass
        elif isinstance(et, datetime):
            end_dt = et

        duration_ms = 0.0
        if start_dt and end_dt:
            duration_ms = max(0.0, (end_dt - start_dt).total_seconds() * 1000.0)

        status_code = data.get("status_code", "OK")
        status_message = data.get("status_message")
        attributes = data.get("attributes", {})

        return cls(
            span_id=span_id,
            trace_id=trace_id,
            name=name,
            span_kind=span_kind,
            start_time=start_dt,
            end_time=end_dt,
            duration_ms=duration_ms,
            parent_id=parent_id,
            status_code=status_code,
            status_message=status_message,
            attributes=attributes,
        )


@dataclass
class ToolExecution:
    name: str
    duration_ms: float = 0.0
    status_code: str = "OK"
    error: Optional[str] = None
    input_summary: str = ""
    output_bytes: int = 0
    span_id: str = ""


@dataclass
class Anomaly:
    type: str  # CONTEXT_CANCELED, TOOL_LOOP, TOKEN_BLOAT, TOOL_ERROR, LATENCY_SPIKE
    severity: str  # CRITICAL, WARNING, INFO
    message: str
    turn_index: Optional[int] = None
    trace_id: Optional[str] = None
    details: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentTurn:
    turn_index: int
    trace_id: str
    agent_name: str = "unknown-agent"
    model_name: str = "unknown-model"
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    duration_ms: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0
    total_tokens: int = 0
    status_code: str = "OK"
    status_message: Optional[str] = None
    prompt_preview: str = ""
    response_preview: str = ""
    tools: List[ToolExecution] = field(default_factory=list)
    spans: List[SpanNode] = field(default_factory=list)


@dataclass
class ThreadTelemetry:
    thread_id: str
    project: str
    session_id: Optional[str] = None
    total_turns: int = 0
    total_tokens: int = 0
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    total_duration_ms: float = 0.0
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    status: str = "OK"
    turns: List[AgentTurn] = field(default_factory=list)
    anomalies: List[Anomaly] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "thread_id": self.thread_id,
            "project": self.project,
            "session_id": self.session_id,
            "total_turns": self.total_turns,
            "total_tokens": self.total_tokens,
            "total_prompt_tokens": self.total_prompt_tokens,
            "total_completion_tokens": self.total_completion_tokens,
            "total_duration_ms": round(self.total_duration_ms, 2),
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "status": self.status,
            "anomalies": [
                {
                    "type": a.type,
                    "severity": a.severity,
                    "message": a.message,
                    "turn_index": a.turn_index,
                    "trace_id": a.trace_id,
                    "details": a.details,
                }
                for a in self.anomalies
            ],
            "turns": [
                {
                    "turn_index": t.turn_index,
                    "trace_id": t.trace_id,
                    "agent": t.agent_name,
                    "model": t.model_name,
                    "status": t.status_code,
                    "status_message": t.status_message,
                    "duration_ms": round(t.duration_ms, 2),
                    "tokens": {
                        "prompt": t.prompt_tokens,
                        "completion": t.completion_tokens,
                        "reasoning": t.reasoning_tokens,
                        "total": t.total_tokens,
                    },
                    "prompt_preview": t.prompt_preview,
                    "response_preview": t.response_preview,
                    "tools": [
                        {
                            "name": tool.name,
                            "status": tool.status_code,
                            "duration_ms": round(tool.duration_ms, 2),
                            "input_summary": tool.input_summary,
                            "output_bytes": tool.output_bytes,
                            "error": tool.error,
                        }
                        for tool in t.tools
                    ],
                }
                for t in self.turns
            ],
        }
