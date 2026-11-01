"""
Arize Phoenix REST API client for buzz-trace.
Uses pure Python standard library (urllib.request) for maximum portability.
"""

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from ..models import SpanNode

logger = logging.getLogger(__name__)


class PhoenixAPIError(Exception):
    """Base exception for Phoenix API failures."""
    pass


class PhoenixClient:
    def __init__(self, endpoint: str = "http://localhost:6006", timeout: float = 10.0):
        self.endpoint = endpoint.rstrip("/")
        self.timeout = timeout

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.endpoint}{path}"
        if params:
            encoded_params = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
            if encoded_params:
                url = f"{url}?{encoded_params}"

        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "buzz-trace/0.1.0",
            },
            method="GET",
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
                if not body:
                    return {}
                return json.loads(body)
        except urllib.error.HTTPError as e:
            err_msg = f"HTTP {e.code} {e.reason} for {url}"
            try:
                err_body = e.read().decode("utf-8")
                err_msg += f" - {err_body}"
            except Exception:
                pass
            raise PhoenixAPIError(err_msg) from e
        except urllib.error.URLError as e:
            raise PhoenixAPIError(f"Connection failed to Phoenix endpoint {self.endpoint}: {e.reason}") from e
        except json.JSONDecodeError as e:
            raise PhoenixAPIError(f"Invalid JSON returned from {url}: {e}") from e
        except Exception as e:
            raise PhoenixAPIError(f"Unexpected error querying {url}: {e}") from e

    def health_check(self) -> bool:
        """Check if Arize Phoenix is healthy and accessible."""
        url = f"{self.endpoint}/healthz"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "buzz-trace/0.1.0"})
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status == 200
        except Exception:
            return False

    def list_projects(self) -> List[Dict[str, Any]]:
        """List all available projects in Phoenix."""
        data = self._get("/v1/projects")
        return data.get("data", [])

    def list_sessions(self, project: str = "mobile", limit: int = 20) -> List[Dict[str, Any]]:
        """List recent sessions for a project."""
        data = self._get(f"/v1/projects/{project}/sessions", {"limit": limit})
        return data.get("data", [])

    def get_session(self, session_identifier: str) -> Optional[Dict[str, Any]]:
        """Fetch session by ID or base64 identifier."""
        try:
            data = self._get(f"/v1/sessions/{session_identifier}")
            return data.get("data")
        except PhoenixAPIError:
            return None

    def get_spans_by_attribute(self, project: str, key: str, value: str) -> List[SpanNode]:
        """Fetch all spans where attribute matches key:value."""
        params = {"attribute": f"{key}:{value}"}
        data = self._get(f"/v1/projects/{project}/spans", params)
        spans_raw = data.get("data", [])
        return [SpanNode.from_dict(s) for s in spans_raw]

    def get_spans_by_trace_id(self, project: str, trace_id: str) -> List[SpanNode]:
        """Fetch all spans for a specific trace ID."""
        params = {"trace_id": trace_id}
        data = self._get(f"/v1/projects/{project}/spans", params)
        spans_raw = data.get("data", [])
        return [SpanNode.from_dict(s) for s in spans_raw]

    def get_spans_for_thread(self, project: str, thread_id: str) -> List[SpanNode]:
        """
        Fetch all spans correlated to a thread ID.
        Checks session.id first, then trace annotations / attributes.
        """
        # Primary lookup: session.id = thread_id
        spans = self.get_spans_by_attribute(project, "session.id", thread_id)
        if spans:
            # Collect full span tree for each unique trace_id
            trace_ids = list(dict.fromkeys(s.trace_id for s in spans if s.trace_id))
            all_spans: List[SpanNode] = []
            for tid in trace_ids:
                all_spans.extend(self.get_spans_by_trace_id(project, tid))
            return all_spans

        # Secondary lookup: Check if thread_id matches session_id in projects/{project}/sessions
        try:
            sessions = self.list_sessions(project, limit=50)
            matched_session = None
            for s in sessions:
                if s.get("session_id") == thread_id or s.get("id") == thread_id:
                    matched_session = s
                    break

            if matched_session:
                all_spans: List[SpanNode] = []
                for tr in matched_session.get("traces", []):
                    tid = tr.get("trace_id")
                    if tid:
                        all_spans.extend(self.get_spans_by_trace_id(project, tid))
                return all_spans
        except Exception:
            pass

        return []
