"""
Markdown formatter for buzz-trace.
Generates structured Markdown reports suitable for PRs, GitLab MRs, and documentation.
"""

from typing import List

from ..models import ThreadTelemetry


class MarkdownRenderer:
    def render(self, t: ThreadTelemetry) -> str:
        lines: List[str] = []

        lines.append(f"# Thread Execution Report: `{t.thread_id[:16]}...`")
        lines.append("")
        lines.append("## 1. Overview")
        lines.append("")
        lines.append("| Metric | Value |")
        lines.append("| :--- | :--- |")
        lines.append(f"| **Thread Root ID** | `{t.thread_id}` |")
        lines.append(f"| **Project** | `{t.project}` |")
        lines.append(f"| **Session ID** | `{t.session_id or 'N/A'}` |")
        lines.append(f"| **Status** | `{t.status}` |")
        lines.append(f"| **Total Turns** | `{t.total_turns}` |")
        lines.append(f"| **Total Tokens** | `{t.total_tokens:,}` (Prompt: `{t.total_prompt_tokens:,}` · Completion: `{t.total_completion_tokens:,}`) |")
        lines.append(f"| **Total Latency** | `{t.total_duration_ms / 1000.0:.2f}s` |")
        lines.append("")

        if t.anomalies:
            lines.append("## 2. Detected Anomalies")
            lines.append("")
            for a in t.anomalies:
                lines.append(f"- **[{a.severity}]** Turn {a.turn_index}: {a.message}")
            lines.append("")

        lines.append("## 3. Turn Timeline")
        lines.append("")
        lines.append("| Turn | Agent | Model | Status | Latency | Tokens | Tools | Trace ID |")
        lines.append("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |")

        for turn in t.turns:
            tools_summary = f"{len(turn.tools)} ops" if turn.tools else "none"
            lines.append(
                f"| **{turn.turn_index}** | `{turn.agent_name}` | `{turn.model_name}` | `{turn.status_code}` | "
                f"`{turn.duration_ms / 1000.0:.1f}s` | `{turn.total_tokens:,}` | {tools_summary} | `{turn.trace_id[:12]}...` |"
            )

        lines.append("")

        if any(turn.tools for turn in t.turns):
            lines.append("## 4. Tool Execution Breakdown")
            lines.append("")
            for turn in t.turns:
                if turn.tools:
                    lines.append(f"### Turn {turn.turn_index} ({turn.agent_name})")
                    for tool in turn.tools:
                        status_mark = "✓" if tool.status_code == "OK" else "✗"
                        lines.append(f"- **{status_mark} `{tool.name}`** ({tool.duration_ms:.0f}ms): `{tool.input_summary}`")
                        if tool.error:
                            lines.append(f"  - *Error:* `{tool.error}`")
                    lines.append("")

        return "\n".join(lines)
