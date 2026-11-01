"""
Terminal formatter for human engineers.
Supports ANSI colors, tree diagrams, and clean box styling.
"""

import os
import sys
from typing import List

from ..models import Anomaly, ThreadTelemetry


class TerminalRenderer:
    def __init__(self, use_colors: bool = True):
        # Disable colors if NO_COLOR env var is present or not a tty and not forced
        self.use_colors = use_colors and ("NO_COLOR" not in os.environ)

    def _c(self, code: str, text: str) -> str:
        if not self.use_colors:
            return text
        return f"\033[{code}m{text}\033[0m"

    def green(self, text: str) -> str:
        return self._c("32;1", text)

    def red(self, text: str) -> str:
        return self._c("31;1", text)

    def yellow(self, text: str) -> str:
        return self._c("33;1", text)

    def cyan(self, text: str) -> str:
        return self._c("36", text)

    def magenta(self, text: str) -> str:
        return self._c("35", text)

    def bold(self, text: str) -> str:
        return self._c("1", text)

    def dim(self, text: str) -> str:
        return self._c("2", text)

    def render(self, t: ThreadTelemetry, verbose: bool = False) -> str:
        lines: List[str] = []

        # 1. Header Banner
        status_badge = self.green("[ OK ]") if t.status == "OK" else self.red(f"[ {t.status} ]")
        lines.append(self.bold("=" * 80))
        lines.append(f"{self.cyan(self.bold('BUZZ-TRACE'))} · Multi-Agent Thread Execution Summary   {status_badge}")
        lines.append(self.bold("=" * 80))

        # Metadata
        lines.append(f"  {self.bold('Thread ID   :')} {self.cyan(t.thread_id)}")
        lines.append(f"  {self.bold('Project     :')} {t.project}")
        if t.session_id:
            lines.append(f"  {self.bold('Session ID  :')} {t.session_id}")
        lines.append(
            f"  {self.bold('Total Tokens:')} {self.yellow(f'{t.total_tokens:,}')} "
            f"(Prompt: {t.total_prompt_tokens:,} · Completion: {t.total_completion_tokens:,})"
        )
        lines.append(
            f"  {self.bold('Total Turns :')} {len(t.turns)} turns · "
            f"{self.bold('Duration:')} {t.total_duration_ms / 1000.0:.2f}s"
        )
        lines.append("")

        # 2. Anomalies Banner (if any)
        if t.anomalies:
            lines.append(self.bold("-" * 80))
            lines.append(f"  {self.red(self.bold('ANOMALIES & DIAGNOSTICS DETECTED:'))}")
            for a in t.anomalies:
                sev_badge = self.red("[CRITICAL]") if a.severity == "CRITICAL" else self.yellow("[WARNING]")
                lines.append(f"    {sev_badge} (Turn {a.turn_index}): {a.message}")
            lines.append(self.bold("-" * 80))
            lines.append("")

        # 3. Turns Timeline
        lines.append(self.bold("CHRONOLOGICAL EXECUTION TIMELINE:"))
        lines.append("")

        if not t.turns:
            lines.append(self.dim("  (No agent turns recorded for this thread)"))
            lines.append("")
            return "\n".join(lines)

        for turn in t.turns:
            turn_badge = self.green("OK") if turn.status_code == "OK" else self.red(turn.status_code)
            dur_str = f"{turn.duration_ms / 1000.0:.1f}s"
            tok_str = f"{turn.total_tokens:,} tok"

            lines.append(
                f"  {self.bold(f'Turn {turn.turn_index}')} · "
                f"{self.cyan(self.bold(turn.agent_name))} "
                f"[{turn_badge}] "
                f"{self.dim(f'({dur_str} · {tok_str})')}"
            )
            lines.append(f"  {self.dim('│')}  {self.bold('Trace ID :')} {turn.trace_id}")
            lines.append(f"  {self.dim('│')}  {self.bold('Model    :')} {self.magenta(turn.model_name)}")

            if turn.prompt_preview:
                lines.append(f"  {self.dim('│')}  {self.bold('Prompt   :')} \"{turn.prompt_preview}\"")

            # Tools
            if turn.tools:
                lines.append(f"  {self.dim('│')}  {self.bold('Tools    :')} {len(turn.tools)} operations")
                for tool in turn.tools:
                    tool_status = self.green("✓") if tool.status_code == "OK" else self.red("✗")
                    tool_dur = f"{tool.duration_ms:.0f}ms"
                    summary = f" - {tool.input_summary}" if tool.input_summary else ""
                    lines.append(
                        f"  {self.dim('│')}    {tool_status} {self.cyan(tool.name)} "
                        f"{self.dim(f'({tool_dur})')}{self.dim(summary)}"
                    )
                    if tool.error:
                        lines.append(f"  {self.dim('│')}      {self.red('Error:')} {tool.error}")
            else:
                lines.append(f"  {self.dim('│')}  {self.bold('Tools    :')} {self.dim('(none)')}")

            if turn.response_preview and verbose:
                lines.append(f"  {self.dim('│')}  {self.bold('Output   :')} \"{turn.response_preview}\"")

            lines.append(f"  {self.dim('└' + '─' * 76)}")
            lines.append("")

        return "\n".join(lines)
