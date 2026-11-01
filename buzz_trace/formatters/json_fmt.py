"""
JSON formatter for buzz-trace.
Outputs clean, compact JSON ideal for LLM prompts, subagents, and programmatic pipelines.
"""

import json
from typing import Any, Dict

from ..models import ThreadTelemetry


class JsonRenderer:
    def __init__(self, indent: int = 2):
        self.indent = indent

    def render(self, telemetry: ThreadTelemetry) -> str:
        return json.dumps(telemetry.to_dict(), indent=self.indent, ensure_ascii=False)
