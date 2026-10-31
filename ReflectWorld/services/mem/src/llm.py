"""LLM client with multi-provider support."""

import re
import logging
from typing import Any

from src.config import MemConfig

logger = logging.getLogger(__name__)

_GPT5_MINI_RE = re.compile(r"(?:^|/)gpt-5-mini$", re.IGNORECASE)


class LLMClient:
    """Unified LLM interface for memory fact extraction and decisions."""

    def __init__(self, config: MemConfig) -> None:
        self.provider = self._normalize_provider(config.llm_provider)
        self.model = config.llm_model
        self.temperature = config.llm_temperature
        self.max_tokens = config.llm_max_tokens
        self._client = self._create_client(config)

    @staticmethod
    def _normalize_provider(provider: str) -> str:
        """Map OpenAI-compatible providers onto the OpenAI SDK path."""
        if provider in ("openai", "azure_openai"):
            return "openai"
        return provider

    def _create_client(self, config: MemConfig) -> Any:
        if self.provider == "openai":
            from openai import OpenAI
            kwargs: dict[str, Any] = {"api_key": config.llm_api_key}
            if config.llm_base_url:
                kwargs["base_url"] = config.llm_base_url
            return OpenAI(**kwargs)
        elif self.provider == "gemini":
            import google.generativeai as genai
            genai.configure(api_key=config.llm_api_key)
            return genai.GenerativeModel(self.model)
        else:
            raise ValueError(f"Unknown LLM provider: {self.provider}")

    def complete(self, messages: list[dict[str, str]], response_format: dict[str, str] | None = None) -> str:
        """Send messages to LLM, return text response."""
        if self.provider == "openai":
            return self._complete_openai(messages, response_format)
        elif self.provider == "gemini":
            return self._complete_gemini(messages, response_format)
        raise ValueError(f"Unknown provider: {self.provider}")

    def _complete_openai(self, messages: list[dict[str, str]], response_format: dict[str, str] | None) -> str:
        is_gpt5_mini = bool(_GPT5_MINI_RE.search(self.model))
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        if is_gpt5_mini:
            kwargs["max_completion_tokens"] = kwargs.pop("max_tokens")
            kwargs.pop("temperature")
        if response_format:
            kwargs["response_format"] = response_format
        response = self._client.chat.completions.create(**kwargs)
        content = response.choices[0].message.content
        if content is None:
            raise RuntimeError("LLM returned empty response")
        return content

    def _complete_gemini(self, messages: list[dict[str, str]], response_format: dict[str, str] | None) -> str:
        # Convert OpenAI message format to Gemini
        parts = []
        for msg in messages:
            role_prefix = f"[{msg['role'].upper()}] " if msg["role"] != "user" else ""
            parts.append(role_prefix + msg["content"])
        prompt = "\n\n".join(parts)
        if response_format and response_format.get("type") == "json_object":
            prompt += "\n\nRespond in valid JSON format only."
        response = self._client.generate_content(prompt)
        return response.text
