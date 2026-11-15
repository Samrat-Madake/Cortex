from unittest.mock import MagicMock, patch
from src.config import MemConfig
from src.llm import LLMClient


def test_complete_openai():
    config = MemConfig(llm_provider="openai", llm_api_key="test-key")
    with patch("openai.OpenAI") as MockOpenAI:
        mock_client = MagicMock()
        MockOpenAI.return_value = mock_client
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content='{"result": "ok"}'))]
        mock_client.chat.completions.create.return_value = mock_response

        client = LLMClient(config)
        result = client.complete([{"role": "user", "content": "test"}])
    assert result == '{"result": "ok"}'


def test_azure_openai_uses_openai_compatible_client():
    config = MemConfig(
        llm_provider="azure_openai",
        llm_api_key="test-key",
        llm_base_url="https://example.test/openai/v1",
    )
    with patch("openai.OpenAI") as MockOpenAI:
        mock_client = MagicMock()
        MockOpenAI.return_value = mock_client
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content='{"result": "ok"}'))]
        mock_client.chat.completions.create.return_value = mock_response

        client = LLMClient(config)
        result = client.complete([{"role": "user", "content": "test"}])

    assert result == '{"result": "ok"}'
    assert client.provider == "openai"
    MockOpenAI.assert_called_once_with(
        api_key="test-key",
        base_url="https://example.test/openai/v1",
    )


def test_complete_with_json_format():
    config = MemConfig(llm_provider="openai", llm_api_key="test-key")
    with patch("openai.OpenAI") as MockOpenAI:
        mock_client = MagicMock()
        MockOpenAI.return_value = mock_client
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content='{"key": "val"}'))]
        mock_client.chat.completions.create.return_value = mock_response

        client = LLMClient(config)
        client.complete(
            [{"role": "user", "content": "test"}],
            response_format={"type": "json_object"},
        )
    call_kwargs = mock_client.chat.completions.create.call_args[1]
    assert call_kwargs["response_format"] == {"type": "json_object"}
