from unittest.mock import MagicMock, patch
from src.config import MemConfig
from src.embedder import Embedder


def test_embed_openai():
    config = MemConfig(embedder_provider="openai", embedder_api_key="test-key")
    with patch("openai.OpenAI") as MockOpenAI:
        mock_client = MagicMock()
        MockOpenAI.return_value = mock_client
        mock_response = MagicMock()
        mock_response.data = [MagicMock(embedding=[0.1] * 1536)]
        mock_client.embeddings.create.return_value = mock_response

        embedder = Embedder(config)
        result = embedder.embed("test text")
    assert len(result) == 1536


def test_embed_reports_success_without_changing_result_when_observer_fails():
    config = MemConfig(embedder_provider="openai", embedder_api_key="test-key")
    observer = MagicMock(side_effect=RuntimeError("observer failure"))
    with patch("openai.OpenAI") as MockOpenAI:
        mock_client = MagicMock()
        MockOpenAI.return_value = mock_client
        mock_client.embeddings.create.return_value.data = [MagicMock(embedding=[0.2, 0.3])]

        result = Embedder(config, observer).embed("test text")

    assert result == [0.2, 0.3]
    observer.assert_called_once()
    assert observer.call_args.kwargs["status"] == "ok"


def test_embed_reports_failure_and_preserves_original_exception():
    config = MemConfig(embedder_provider="openai", embedder_api_key="test-key")
    observer = MagicMock(side_effect=RuntimeError("observer failure"))
    with patch("openai.OpenAI") as MockOpenAI:
        mock_client = MagicMock()
        MockOpenAI.return_value = mock_client
        mock_client.embeddings.create.side_effect = ValueError("embedding failed")

        try:
            Embedder(config, observer).embed("test text")
            raise AssertionError("expected embedding failure")
        except ValueError as exc:
            assert str(exc) == "embedding failed"

    assert observer.call_args.kwargs["status"] == "down"
