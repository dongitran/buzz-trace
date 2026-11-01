"""
Arize Phoenix SQLite direct reader for buzz-trace.
Queries the local database file directly in read-only mode (<5ms latency).
"""

import json
import logging
import os
import sqlite3
from typing import Any, Dict, List, Optional

from ..models import SpanNode

logger = logging.getLogger(__name__)


class PhoenixDBClient:
    def __init__(self, db_path: str):
        if not os.path.exists(db_path):
            raise FileNotFoundError(f"Phoenix SQLite database not found at {db_path}")
        self.db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        # Connect in read-only mode to prevent any locking or modification
        uri = f"file:{os.path.abspath(self.db_path)}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5.0)
        conn.row_factory = sqlite3.Row
        return conn

    def get_spans_for_thread(self, thread_id: str) -> List[SpanNode]:
        """Fetch all spans where session.id equals thread_id."""
        query = """
            SELECT 
                t.trace_id,
                s.span_id,
                s.parent_id,
                s.name,
                s.span_kind,
                s.start_time,
                s.end_time,
                s.status_code,
                s.status_message,
                s.attributes
            FROM spans s
            JOIN traces t ON s.trace_rowid = t.id
            WHERE json_extract(s.attributes, '$.session.id') = ?
               OR json_extract(s.attributes, '$.attributes.session.id') = ?
            ORDER BY s.start_time ASC;
        """
        spans: List[SpanNode] = []
        try:
            with self._connect() as conn:
                cursor = conn.cursor()
                cursor.execute(query, (thread_id, thread_id))
                for row in cursor.fetchall():
                    raw_attrs = row["attributes"]
                    attrs: Dict[str, Any] = {}
                    if raw_attrs:
                        try:
                            attrs = json.loads(raw_attrs) if isinstance(raw_attrs, str) else raw_attrs
                        except Exception:
                            pass

                    spans.append(
                        SpanNode(
                            span_id=row["span_id"],
                            trace_id=row["trace_id"],
                            name=row["name"],
                            span_kind=row["span_kind"],
                            start_time=row["start_time"],
                            end_time=row["end_time"],
                            parent_id=row["parent_id"],
                            status_code=row["status_code"] or "OK",
                            status_message=row["status_message"],
                            attributes=attrs,
                        )
                    )
        except Exception as e:
            logger.error(f"Error reading Phoenix database: {e}")
            raise

        return spans
