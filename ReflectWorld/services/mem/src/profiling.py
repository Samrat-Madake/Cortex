"""Lightweight request-scoped profiling for memory operations.

The profiler is intentionally observation-only: it records duration/counter
metadata and never changes control flow or storage behavior.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from time import perf_counter
from typing import Any, Iterator


class MemoryProfiler:
    """Aggregate timing spans for one memory request."""

    def __init__(self, name: str, metadata: dict[str, Any] | None = None) -> None:
        self.name = name
        self.metadata = metadata or {}
        self._started_at = perf_counter()
        self._stages: dict[str, dict[str, float | int]] = {}
        self._counters: dict[str, int] = {}

    @contextmanager
    def span(self, name: str) -> Iterator[None]:
        started_at = perf_counter()
        try:
            yield
        finally:
            self.record(name, (perf_counter() - started_at) * 1000)

    def record(self, name: str, duration_ms: float) -> None:
        stage = self._stages.setdefault(name, {"count": 0, "total_ms": 0.0, "max_ms": 0.0})
        stage["count"] = int(stage["count"]) + 1
        stage["total_ms"] = float(stage["total_ms"]) + duration_ms
        stage["max_ms"] = max(float(stage["max_ms"]), duration_ms)

    def add_counter(self, name: str, value: int = 1) -> None:
        self._counters[name] = self._counters.get(name, 0) + value

    def to_dict(self) -> dict[str, Any]:
        stages: dict[str, dict[str, int | float]] = {}
        for name, stage in self._stages.items():
            count = int(stage["count"])
            total_ms = round(float(stage["total_ms"]), 3)
            stages[name] = {
                "count": count,
                "total_ms": total_ms,
                "max_ms": round(float(stage["max_ms"]), 3),
                "avg_ms": round(total_ms / count, 3) if count else 0,
            }
        return {
            "name": self.name,
            "total_ms": round((perf_counter() - self._started_at) * 1000, 3),
            "stages": stages,
            "counters": dict(self._counters),
            "metadata": dict(self.metadata),
        }


_current_profiler: ContextVar[MemoryProfiler | None] = ContextVar(
    "memory_profiler",
    default=None,
)


def current_profiler() -> MemoryProfiler | None:
    return _current_profiler.get()


def start_memory_profile(
    name: str,
    metadata: dict[str, Any] | None = None,
) -> tuple[MemoryProfiler, Any]:
    profiler = MemoryProfiler(name, metadata)
    token = _current_profiler.set(profiler)
    return profiler, token


def reset_memory_profile(token: Any) -> None:
    _current_profiler.reset(token)


def attach_profile(response: dict[str, Any], profiler: MemoryProfiler) -> dict[str, Any]:
    response["profile"] = profiler.to_dict()
    return response
