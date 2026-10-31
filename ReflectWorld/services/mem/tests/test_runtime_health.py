import queue
from unittest.mock import MagicMock, patch

from src.runtime_health import RuntimeHealthReporter


def test_runtime_health_uses_dashboard_health_endpoint_for_custom_webhook_path() -> None:
    with patch("threading.Thread.start"):
        reporter = RuntimeHealthReporter(
            "https://dashboard.example/internal/memory-hook?token=ignored"
        )

    assert reporter._url == "https://dashboard.example/api/runtime-health/observe"


def test_runtime_health_sends_internal_webhook_token() -> None:
    with patch("threading.Thread.start"):
        reporter = RuntimeHealthReporter(
            "http://127.0.0.1:3211/api/memory-event", "test-secret"
        )

    assert reporter._headers == {"X-ReflectWorld-Internal-Token": "test-secret"}


def test_runtime_health_checks_http_response_status() -> None:
    with patch("threading.Thread.start"):
        reporter = RuntimeHealthReporter("http://127.0.0.1:3211/api/memory-event")
    reporter._queue.put({"component": "memory", "status": "ok"})
    reporter._queue.put(None)
    response = MagicMock()
    client = MagicMock()
    client.post.return_value = response
    context = MagicMock()
    context.__enter__.return_value = client

    with patch("src.runtime_health.httpx.Client", return_value=context):
        reporter._run()

    response.raise_for_status.assert_called_once_with()


def test_runtime_health_coalesces_per_scope() -> None:
    with patch("threading.Thread.start"):
        reporter = RuntimeHealthReporter("http://127.0.0.1:3211/api/memory-event")

    reporter.observe(
        component="memory",
        operation="semantic_update",
        status="down",
        scope={"user_id": "user-a", "source_id": "cam-a"},
    )
    reporter.observe(
        component="memory",
        operation="semantic_update",
        status="down",
        scope={"user_id": "user-a", "source_id": "cam-a"},
    )
    reporter.observe(
        component="memory",
        operation="semantic_update",
        status="ok",
        scope={"user_id": "user-b", "source_id": "cam-b"},
    )

    first = reporter._queue.get_nowait()
    second = reporter._queue.get_nowait()
    assert first is not None
    assert second is not None
    assert first["scope"] == {"user_id": "user-a", "source_id": "cam-a"}
    assert second["scope"] == {"user_id": "user-b", "source_id": "cam-b"}
    assert reporter._queue.empty()


def test_runtime_health_keeps_latest_observation_when_queue_is_full() -> None:
    with patch("threading.Thread.start"):
        reporter = RuntimeHealthReporter("http://127.0.0.1:3211/api/memory-event")
    reporter._queue = queue.Queue(maxsize=1)

    reporter.observe(component="memory_search", operation="search", status="down")
    reporter.observe(component="memory_search", operation="search", status="ok")

    latest = reporter._queue.get_nowait()
    assert latest is not None
    assert latest["status"] == "ok"


def test_runtime_health_close_replaces_oldest_item_when_queue_is_full() -> None:
    with patch("threading.Thread.start"):
        reporter = RuntimeHealthReporter("http://127.0.0.1:3211/api/memory-event")
    reporter._queue = queue.Queue(maxsize=1)
    reporter.observe(component="memory_search", operation="search", status="down")

    reporter.close()
    reporter.observe(component="memory_search", operation="search", status="ok")

    assert reporter._queue.get_nowait() is None


def test_runtime_health_observation_never_escapes_invalid_telemetry_input() -> None:
    with patch("threading.Thread.start"):
        reporter = RuntimeHealthReporter("http://127.0.0.1:3211/api/memory-event")

    reporter.observe(
        component="memory",
        operation="semantic_update",
        status="down",
        scope={"source_id": object()},  # type: ignore[dict-item]
    )

    assert reporter._queue.empty()
