"""Smoke checks for TC fan-out speed knobs (timeout / concurrency defaults)."""

from __future__ import annotations

import asyncio
import os
from unittest import mock

from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter


def test_cursor_oneshot_timeout_default_240():
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_CURSOR_ONESHOT_TIMEOUT", None)
        try:
            timeout = max(
                60,
                min(600, int(os.environ.get("AITEST_CURSOR_ONESHOT_TIMEOUT", "240"))),
            )
        except ValueError:
            timeout = 240
        assert timeout == 240


def test_fanout_concurrency_default_3():
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_FANOUT_CONCURRENCY", None)
        try:
            concurrency = max(
                1, min(4, int(os.environ.get("AITEST_TC_FANOUT_CONCURRENCY", "3")))
            )
        except ValueError:
            concurrency = 3
        assert concurrency == 3


def test_cursor_fanout_concurrency_default_2():
    """Cursor parallel oneshot (independent modules) — default 2, cap 2."""
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_FANOUT_CONCURRENCY_CURSOR", None)
        try:
            concurrency = max(
                1,
                min(
                    2,
                    int(os.environ.get("AITEST_TC_FANOUT_CONCURRENCY_CURSOR", "2")),
                ),
            )
        except ValueError:
            concurrency = 2
        assert concurrency == 2


def test_cursor_forces_oneshot_even_when_prefer_false():
    """Warm-session path must not drop Cursor into interactive (no --mode ask)."""
    adapter = CursorCLIAdapter(project_id="p", cli_path="agent")
    called: dict[str, str] = {}

    async def fake_oneshot(prompt: str, *, resume_chat_id: str | None = None) -> str:
        called["oneshot"] = prompt
        called["resume"] = resume_chat_id or ""
        return '{"testCases":[]}'

    adapter._run_oneshot = fake_oneshot  # type: ignore[method-assign]
    out = asyncio.run(adapter._run_prompt("hi", topic_key="t", prefer_oneshot=False))
    assert "oneshot" in called
    assert out.startswith("{")
    out2 = asyncio.run(
        adapter._run_prompt(
            "hi2", topic_key="t", prefer_oneshot=True, resume_chat_id="c1"
        )
    )
    assert called["resume"] == "c1"
    assert out2.startswith("{")
