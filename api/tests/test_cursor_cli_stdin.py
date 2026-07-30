"""Cursor CLI — stdin long prompt + create-chat helpers."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter


def test_long_prompt_uses_stdin_not_file_ref():
    adapter = CursorCLIAdapter("proj-1", cli_path="agent")
    long_prompt = "x" * 4000
    stream = AsyncMock(return_value='{"ok":true}')

    with patch.object(adapter, "_stream_oneshot", stream):
        out = asyncio.run(adapter._run_oneshot(long_prompt, resume_chat_id="chat-1"))

    assert out == '{"ok":true}'
    stream.assert_awaited()
    args, kwargs = stream.await_args
    cmd = args[0]
    assert "--resume" in cmd
    assert "chat-1" in cmd
    assert kwargs.get("stdin_text") == long_prompt
    # prompt must not be appended as argv for long body
    assert long_prompt not in cmd
    assert not any("Đọc toàn bộ" in str(a) for a in cmd)


def test_short_prompt_stays_on_argv():
    adapter = CursorCLIAdapter("proj-1", cli_path="agent")
    short = "hello"
    stream = AsyncMock(return_value="ok")
    with patch.object(adapter, "_stream_oneshot", stream):
        asyncio.run(adapter._run_oneshot(short))
    args, kwargs = stream.await_args
    assert kwargs.get("stdin_text") is None
    assert args[0][-1] == short
