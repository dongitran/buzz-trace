"""
Thread Telemetry Aggregator.
Assembles raw OpenTelemetry spans across multiple agent turns into a unified ThreadTelemetry timeline.
"""

from collections import defaultdict
from typing import Dict, List, Optional

from ..models import AgentTurn, SpanNode, ThreadTelemetry, ToolExecution


class ThreadAggregator:
    def __init__(self, thread_id: str, project: str = "mobile", session_id: Optional[str] = None):
        self.thread_id = thread_id
        self.project = project
        self.session_id = session_id

    def aggregate(self, spans: List[SpanNode]) -> ThreadTelemetry:
        """
        Takes a flat list of SpanNodes belonging to a thread,
        groups them by trace_id, builds AgentTurns, and produces ThreadTelemetry.
        """
        if not spans:
            return ThreadTelemetry(
                thread_id=self.thread_id,
                project=self.project,
                session_id=self.session_id,
                status="NOT_FOUND",
            )

        # 1. Group spans by trace_id
        traces_map: Dict[str, List[SpanNode]] = defaultdict(list)
        for s in spans:
            if s.trace_id:
                traces_map[s.trace_id].append(s)

        # 2. Build AgentTurn for each trace
        turns: List[AgentTurn] = []
        for trace_id, trace_spans in traces_map.items():
            turn = self._build_turn(trace_id, trace_spans)
            turns.append(turn)

        # 3. Sort turns chronologically
        turns.sort(key=lambda t: t.start_time if t.start_time else t.duration_ms)

        # Assign sequential turn_index
        for idx, turn in enumerate(turns, start=1):
            turn.turn_index = idx

        # 4. Compute aggregate metrics
        total_tokens = sum(t.total_tokens for t in turns)
        total_prompt_tokens = sum(t.prompt_tokens for t in turns)
        total_completion_tokens = sum(t.completion_tokens for t in turns)
        total_duration_ms = sum(t.duration_ms for t in turns)

        thread_start = turns[0].start_time if turns and turns[0].start_time else None
        thread_end = turns[-1].end_time if turns and turns[-1].end_time else None

        overall_status = "OK"
        if any(t.status_code == "ERROR" for t in turns):
            overall_status = "ERROR"

        return ThreadTelemetry(
            thread_id=self.thread_id,
            project=self.project,
            session_id=self.session_id or (turns[0].spans[0].attributes.get("session.id") if turns and turns[0].spans else None),
            total_turns=len(turns),
            total_tokens=total_tokens,
            total_prompt_tokens=total_prompt_tokens,
            total_completion_tokens=total_completion_tokens,
            total_duration_ms=total_duration_ms,
            start_time=thread_start,
            end_time=thread_end,
            status=overall_status,
            turns=turns,
        )

    def _build_turn(self, trace_id: str, spans: List[SpanNode]) -> AgentTurn:
        # Find root span (parent_id is None, or name == 'agent_turn')
        root_span = None
        for s in spans:
            if s.name == "agent_turn" or s.parent_id is None:
                root_span = s
                break
        if not root_span and spans:
            root_span = spans[0]

        turn_start = root_span.start_time if root_span else None
        turn_end = root_span.end_time if root_span else None
        turn_duration = root_span.duration_ms if root_span else 0.0
        turn_status = root_span.status_code if root_span else "OK"
        turn_msg = root_span.status_message if root_span else None

        # Look for agent identity in attributes
        agent_name = "unknown-agent"
        if root_span:
            attrs = root_span.attributes
            agent_name = (
                attrs.get("agent.name")
                or attrs.get("service.name")
                or attrs.get("agent_name")
                or attrs.get("community.agent")
                or "phoenix-twin"  # default standard agent in current ecosystem
            )

        # Find LLM model & token stats
        model_name = "unknown-model"
        prompt_tokens = 0
        completion_tokens = 0
        reasoning_tokens = 0
        total_tokens = 0

        prompt_preview = ""
        response_preview = ""

        tools: List[ToolExecution] = []

        for s in spans:
            attrs = s.attributes
            # Check for LLM span
            if s.name.startswith("llm:") or s.span_kind in ("LLM", "SPAN_KIND_INTERNAL") and "llm.model_name" in attrs:
                model_name = attrs.get("llm.model_name") or model_name
                prompt_tokens += int(attrs.get("llm.token_count.prompt", 0))
                completion_tokens += int(attrs.get("llm.token_count.completion", 0))
                reasoning_tokens += int(attrs.get("llm.token_count.completion_details.reasoning", 0))
                total_tokens += int(attrs.get("llm.token_count.total", 0))

            # Prompt / Response previews
            if not prompt_preview and "input.value" in attrs:
                raw_in = str(attrs["input.value"]).strip()
                prompt_preview = raw_in[:120] + ("..." if len(raw_in) > 120 else "")
            if not response_preview and "output.value" in attrs:
                raw_out = str(attrs["output.value"]).strip()
                response_preview = raw_out[:120] + ("..." if len(raw_out) > 120 else "")

            # Check for Tool span
            if s.name.startswith("tool:") or s.span_kind in ("TOOL", "SPAN_KIND_INTERNAL") and "tool.name" in attrs:
                tool_name = attrs.get("tool.name") or s.name.replace("tool:", "")
                tool_in = str(attrs.get("input.value", ""))[:80]
                tool_bytes = int(attrs.get("tool.output_bytes", 0))
                tools.append(
                    ToolExecution(
                        name=tool_name,
                        duration_ms=s.duration_ms,
                        status_code=s.status_code,
                        error=s.status_message if s.status_code == "ERROR" else None,
                        input_summary=tool_in,
                        output_bytes=tool_bytes,
                        span_id=s.span_id,
                    )
                )

        # Fallback token total
        if total_tokens == 0 and (prompt_tokens > 0 or completion_tokens > 0):
            total_tokens = prompt_tokens + completion_tokens

        return AgentTurn(
            turn_index=0,  # Will be assigned by aggregate()
            trace_id=trace_id,
            agent_name=agent_name,
            model_name=model_name,
            start_time=turn_start,
            end_time=turn_end,
            duration_ms=turn_duration,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            reasoning_tokens=reasoning_tokens,
            total_tokens=total_tokens,
            status_code=turn_status,
            status_message=turn_msg,
            prompt_preview=prompt_preview,
            response_preview=response_preview,
            tools=tools,
            spans=spans,
        )
