"""LLM port adapters — wrap existing Provider classes."""

from __future__ import annotations

from app.llm.providers import Anthropic, Antigravity, Gemini, Ollama, OpenAI, Provider

# Existing Provider already satisfies LlmPort (verify + chat).
PROVIDER_REGISTRY: dict[str, type[Provider]] = {
    "openai": OpenAI,
    "anthropic": Anthropic,
    "gemini": Gemini,
    "ollama": Ollama,
    "antigravity": Antigravity,
}


def get_llm_provider(name: str, model: str | None = None) -> Provider:
    key = (name or "openai").lower().strip()
    cls = PROVIDER_REGISTRY.get(key, OpenAI)
    if model:
        try:
            return cls(model=model)  # type: ignore[call-arg]
        except TypeError:
            return cls()
    return cls()
