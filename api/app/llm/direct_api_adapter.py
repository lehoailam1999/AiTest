"""Direct API Key adapter — wraps existing Provider.generate / generate_unit."""

from __future__ import annotations

from typing import Any

from app.llm.base import GenerateContext, TestCaseDraft, UnitRequest, UnitResult
from app.llm.base_adapter import BaseLLMAdapter
from app.llm.providers import Provider, generate_unit as provider_generate_unit


class DirectAPIAdapter(BaseLLMAdapter):
    def __init__(self, provider: Provider, api_key: str):
        self.provider = provider
        self.api_key = api_key

    async def generate_test_cases(
        self,
        title: str,
        requirement_text: str,
        *,
        ctx: GenerateContext | None = None,
        topic_scope: str | None = None,
        context: dict[str, Any] | None = None,
        on_progress: Any | None = None,
        prefer_oneshot: bool | None = None,
        session_topic_key: str | None = None,
        resume_chat_id: str | None = None,
        create_chat: bool = False,
    ) -> list[TestCaseDraft]:
        del context, prefer_oneshot, session_topic_key, resume_chat_id, create_chat
        if on_progress:
            on_progress("Đang gọi API Direct…")
        ctx = ctx or GenerateContext()
        if topic_scope and not ctx.topic_scope:
            ctx.topic_scope = topic_scope
        return await self.provider.generate(self.api_key, title, requirement_text, ctx)

    async def health_check(self) -> bool:
        try:
            await self.provider.verify(self.api_key)
            return True
        except Exception:
            return False

    async def chat(
        self,
        system: str,
        user: str,
        *,
        resume_chat_id: str | None = None,
        create_chat: bool = False,
    ) -> str:
        del resume_chat_id, create_chat
        return await self.provider.chat(self.api_key, system, user)

    async def generate_unit(self, req: UnitRequest) -> UnitResult:
        return await provider_generate_unit(self.provider, self.api_key, req)
