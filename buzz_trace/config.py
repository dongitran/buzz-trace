"""
Configuration and environment auto-detection for buzz-trace.
"""

import os
from dataclasses import dataclass
from typing import Optional


@dataclass
class Config:
    endpoint: str = "http://localhost:6006"
    project: str = "mobile"
    db_path: Optional[str] = None
    timeout: float = 10.0
    max_retries: int = 3
    show_secrets: bool = False

    @classmethod
    def load(
        cls,
        endpoint: Optional[str] = None,
        project: Optional[str] = None,
        db_path: Optional[str] = None,
        show_secrets: bool = False,
    ) -> "Config":
        # Resolve endpoint: CLI arg -> env vars -> default
        resolved_endpoint = (
            endpoint
            or os.environ.get("PHOENIX_ENDPOINT")
            or os.environ.get("PHOENIX_COLLECTOR_ENDPOINT")
            or "http://localhost:6006"
        ).rstrip("/")

        # If endpoint has /v1 at the end, strip it
        if resolved_endpoint.endswith("/v1"):
            resolved_endpoint = resolved_endpoint[:-3]

        # Resolve project: CLI arg -> env var -> default
        resolved_project = (
            project
            or os.environ.get("PHOENIX_PROJECT")
            or "mobile"
        )

        # Resolve db_path: CLI arg -> env var -> check standard paths
        resolved_db = db_path or os.environ.get("PHOENIX_DB_PATH")
        if not resolved_db:
            candidate_paths = [
                "/root/.phoenix/phoenix.db",
                os.path.expanduser("~/.phoenix/phoenix.db"),
            ]
            for p in candidate_paths:
                if os.path.exists(p):
                    resolved_db = p
                    break

        return cls(
            endpoint=resolved_endpoint,
            project=resolved_project,
            db_path=resolved_db,
            show_secrets=show_secrets,
        )
