"""Shared LLM adapter interface (API Direct + AI CLI)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any

from app.llm.base import GenerateContext, TestCaseDraft, UnitRequest, UnitResult

ProgressCb = Callable[[str], None]


class BaseLLMAdapter(ABC):
    @abstractmethod
    async def generate_test_cases(
        self,
        title: str,
        requirement_text: str,
        *,
        ctx: GenerateContext | None = None,
        topic_scope: str | None = None,
        context: dict[str, Any] | None = None,
        on_progress: ProgressCb | None = None,
        prefer_oneshot: bool | None = None,
        session_topic_key: str | None = None,
    ) -> list[TestCaseDraft]:
        """Sinh danh sách TestCaseDraft từ requirement."""

    @abstractmethod
    async def health_check(self) -> bool:
        """Kiểm tra kết nối / CLI executable sẵn sàng."""

    @abstractmethod
    async def chat(self, system: str, user: str) -> str:
        """Chat / JSON enrich (Phân tích Knowledge, v.v.)."""

    @abstractmethod
    async def generate_unit(self, req: UnitRequest) -> UnitResult:
        """Sinh mã Unit Test (Phase 2) từ Approved TC + source context."""
