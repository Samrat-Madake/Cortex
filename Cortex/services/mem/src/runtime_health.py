"""Best-effort runtime health reporting for the local Dashboard."""

from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

logger = logging.getLogger(__name__)


class RuntimeHealthReporter:
    """Send bounded, non-blocking health observations from sync model clients."""

    def __init__(self, monitor_webhook_url: str, internal_webhook_token: str = "") -> None:
        parsed_url = urlsplit(monitor_webhook_url)
        self._url = urlunsplit(
            parsed_url._replace(path="/api/runtime-health/observe", query="", fragment="")
        )
        self._headers = (
            {"X-Cortex-Internal-Token": internal_webhook_token}
            if internal_webhook_token
            else None
        )
        self._epoch = f"{time.time_ns():x}"
        self._sequence = 0
        self._queue: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=64)
        self._last: dict[tuple[str, str, str, str, str], tuple[str, float]] = {}
        self._lock = threading.Lock()
        self._closed = False
        self._worker = threading.Thread(
            target=self._run, name="runtime-health-reporter", daemon=True
        )
        self._worker.start()

    def observe(
        self,
        *,
        component: str,
        operation: str,
        status: str,
        code: str | None = None,
        latency_ms: float | None = None,
        scope: dict[str, str] | None = None,
    ) -> None:
        try:
            now = time.monotonic()
            normalized_scope = {
                key: value[:160]
                for key, value in (scope or {}).items()
                if key in {"user_id", "session_id", "source_id"} and value
            }
            key = (
                component,
                operation,
                normalized_scope.get("user_id", ""),
                normalized_scope.get("session_id", ""),
                normalized_scope.get("source_id", ""),
            )
            with self._lock:
                if self._closed:
                    return
                previous = self._last.get(key)
                if previous and previous[0] == status and now - previous[1] < 60:
                    return
                self._last[key] = (status, now)
                self._sequence += 1
                payload: dict[str, Any] = {
                    "producer": "memory-service",
                    "producer_epoch": self._epoch,
                    "sequence": self._sequence,
                    "component": component,
                    "operation": operation,
                    "status": status,
                    "observed_at": int(time.time() * 1000),
                }
                if code:
                    payload["code"] = code
                if latency_ms is not None:
                    payload["latency_ms"] = round(latency_ms, 1)
                if normalized_scope:
                    payload["scope"] = normalized_scope
                self._enqueue_latest(payload)
        except Exception:
            return

    def _enqueue_latest(self, payload: dict[str, Any] | None) -> None:
        try:
            self._queue.put_nowait(payload)
            return
        except queue.Full:
            pass
        try:
            self._queue.get_nowait()
            self._queue.task_done()
        except queue.Empty:
            pass
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            return

    def _run(self) -> None:
        with httpx.Client(timeout=2.0) as client:
            while True:
                payload = self._queue.get()
                try:
                    if payload is None:
                        return
                    response = client.post(self._url, json=payload, headers=self._headers)
                    response.raise_for_status()
                except Exception as exc:
                    logger.debug("Runtime health report failed (non-fatal): %s", exc)
                finally:
                    self._queue.task_done()

    def close(self) -> None:
        """Request worker shutdown without blocking the service lifecycle."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._enqueue_latest(None)
