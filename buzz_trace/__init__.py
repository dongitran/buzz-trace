"""
buzz-trace: Distributed Thread Observability & Diagnostic CLI for Multi-Agent Nostr Networks.
"""

__version__ = "0.1.0"
__author__ = "Đông Trần"

from .models import SpanNode, ToolExecution, AgentTurn, ThreadTelemetry
from .engine.aggregator import ThreadAggregator
from .clients.phoenix_api import PhoenixClient

__all__ = [
    "SpanNode",
    "ToolExecution",
    "AgentTurn",
    "ThreadTelemetry",
    "ThreadAggregator",
    "PhoenixClient",
]
