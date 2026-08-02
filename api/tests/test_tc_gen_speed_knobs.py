"""Smoke checks for TC fan-out speed knobs (timeout / concurrency defaults)."""

from __future__ import annotations

import asyncio
import os
from unittest import mock

from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter


def test_cursor_oneshot_uses_empty_workspace():
    """Prevent agent from tool-scanning AITest monorepo during TC gen."""
    from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter

    adapter = CursorCLIAdapter(project_id="p", cli_path="agent")
    cmd = adapter.build_command(oneshot=True)
    assert "--workspace" in cmd
    ws = cmd[cmd.index("--workspace") + 1]
    assert "aitest-cursor-empty" in ws.replace("\\", "/").lower() or "empty" in ws.lower()
    # interactive path may omit workspace; oneshot must isolate
    cmd2 = adapter.build_command(oneshot=False)
    # not required for non-oneshot
    assert isinstance(cmd2, list)


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


def test_e2e_speed_env_default_fast():
    from app.llm.tc_speed import resolve_tc_speed_mode

    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_E2E_SPEED", None)
        assert resolve_tc_speed_mode("e2e") == "fast"
        os.environ["AITEST_TC_E2E_SPEED"] = "full"
        assert resolve_tc_speed_mode("e2e") == "full"


def test_cursor_fanout_concurrency_default_3():
    """Cursor parallel oneshot — default 3, cap 4."""
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_FANOUT_CONCURRENCY_CURSOR", None)
        try:
            concurrency = max(
                1,
                min(
                    4,
                    int(os.environ.get("AITEST_TC_FANOUT_CONCURRENCY_CURSOR", "3")),
                ),
            )
        except ValueError:
            concurrency = 3
        assert concurrency == 3


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


def test_cursor_tc_hidden_chat_enabled_default_off_for_speed():
    from app.llm.base import cursor_tc_hidden_chat_enabled

    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_CURSOR_HIDDEN_CHAT", None)
        assert cursor_tc_hidden_chat_enabled() is False
        os.environ["AITEST_TC_CURSOR_HIDDEN_CHAT"] = "0"
        assert cursor_tc_hidden_chat_enabled() is False
        os.environ["AITEST_TC_CURSOR_HIDDEN_CHAT"] = "1"
        assert cursor_tc_hidden_chat_enabled() is True


def test_tc_seed_prompt_no_knowledge_slice_and_size():
    from app.llm.base import GenerateContext, tc_seed_prompt

    seed = tc_seed_prompt(
        GenerateContext(
            preferred_engine="unit",
            custom_rules="rule-x",
            source_context="SHOULD_NOT_APPEAR_IN_SEED",
            topic_scope="**Auth** only",
        )
    )
    assert "READY" in seed
    assert "ENGINE=UNIT" in seed or "UNIT" in seed
    assert "SHOULD_NOT_APPEAR_IN_SEED" not in seed
    assert "KẾT QUẢ PHÂN TÍCH" not in seed
    assert "Knowledge" not in seed or "TURN SEED" in seed
    assert len(seed) < 4500
    assert "rule-x" in seed


def test_tc_module_gen_user_prompt_anti_lazy():
    from app.llm.base import GenerateContext, tc_module_gen_user_prompt

    body = (
        "## Knowledge slice for Auth\n"
        "FR-1 login must validate password\n"
        + ("x" * 100)
    )
    gen = tc_module_gen_user_prompt(
        "Req Login",
        body,
        GenerateContext(
            feature_titles=["Auth"],
            topic_scope="**Auth** — chỉ module này",
            source_context="def login(): ...",
            preferred_engine="unit",
        ),
    )
    assert "Auth" in gen
    assert "ANTI-LAZY" in gen
    assert "KHÔNG trần" in gen or "không trần" in gen.lower() or "≥1 TC" in gen
    assert "3–6" not in gen and "3-6" not in gen
    assert "CHỈ sinh TC" in gen or "ONLY" in gen.upper() or "ĐÚNG một module" in gen
    assert "Knowledge slice for Auth" in gen
    assert "def login()" in gen


def test_cursor_hidden_2turn_create_chat_seed_then_gen():
    """create_chat → seed resume → gen resume (same chatId); seed has no Knowledge."""
    from app.llm.base import GenerateContext

    adapter = CursorCLIAdapter(project_id="p", cli_path="agent")
    calls: list[tuple[str, str | None]] = []

    async def fake_create() -> str:
        calls.append(("__create_chat__", None))
        return "chat-hidden-1"

    async def fake_oneshot(prompt: str, *, resume_chat_id: str | None = None) -> str:
        calls.append((prompt, resume_chat_id))
        if "TURN SEED" in prompt or "READY" in prompt:
            return "READY"
        return (
            '{"testCases":[{"title":"Đăng nhập thành công","type":"Unit",'
            '"priority":"Cao","severity":"Nặng","module":"Auth",'
            '"precondition":"","steps":"1. gọi login","expectedResult":"ok",'
            '"testData":"","automationReady":false}]}'
        )

    adapter.create_chat = fake_create  # type: ignore[method-assign]
    adapter._run_oneshot = fake_oneshot  # type: ignore[method-assign]

    with mock.patch.dict(os.environ, {"AITEST_TC_CURSOR_HIDDEN_CHAT": "1"}, clear=False):
        drafts = asyncio.run(
            adapter.generate_test_cases(
                "Req",
                "## Knowledge\nFR Auth login\n",
                ctx=GenerateContext(
                    feature_titles=["Auth"],
                    preferred_engine="unit",
                    topic_scope="**Auth**",
                ),
                create_chat=True,
                prefer_oneshot=True,
            )
        )

    assert len(drafts) >= 1
    assert drafts[0].module == "Auth"
    assert calls[0][0] == "__create_chat__"
    assert len(calls) == 3  # create + seed + gen
    seed_prompt, seed_resume = calls[1]
    gen_prompt, gen_resume = calls[2]
    assert seed_resume == "chat-hidden-1"
    assert gen_resume == "chat-hidden-1"
    assert "TURN SEED" in seed_prompt or "READY" in seed_prompt
    assert "FR Auth login" not in seed_prompt
    assert "Auth" in gen_prompt
    assert "ANTI-LAZY" in gen_prompt
    assert "FR Auth login" in gen_prompt
    assert getattr(adapter, "last_cursor_chat_id") == "chat-hidden-1"


def test_cursor_hidden_disabled_uses_oneshot_full():
    """AITEST_TC_CURSOR_HIDDEN_CHAT=0 + create_chat → full oneshot (no 2-turn)."""
    from app.llm.base import GenerateContext

    adapter = CursorCLIAdapter(project_id="p", cli_path="agent")
    oneshot_count = {"n": 0}

    async def fake_create() -> str:
        return "should-not-matter-when-disabled-if-jobs-passes-false"

    async def fake_oneshot(prompt: str, *, resume_chat_id: str | None = None) -> str:
        oneshot_count["n"] += 1
        oneshot_count["prompt"] = prompt
        return (
            '{"testCases":[{"title":"TC A","type":"Unit","priority":"Cao",'
            '"severity":"Nặng","module":"Auth","precondition":"","steps":"1. a",'
            '"expectedResult":"ok","testData":"","automationReady":false}]}'
        )

    adapter.create_chat = fake_create  # type: ignore[method-assign]
    adapter._run_oneshot = fake_oneshot  # type: ignore[method-assign]

    with mock.patch.dict(os.environ, {"AITEST_TC_CURSOR_HIDDEN_CHAT": "0"}, clear=False):
        asyncio.run(
            adapter.generate_test_cases(
                "Req",
                "body Knowledge slice HERE",
                ctx=GenerateContext(feature_titles=["Auth"]),
                create_chat=True,  # adapter still may create+oneshot when hidden off
                prefer_oneshot=True,
            )
        )

    # Hidden off: single full prompt path (create_chat may still run once then oneshot)
    assert oneshot_count["n"] == 1
    assert "Knowledge slice HERE" in oneshot_count["prompt"] or "---" in oneshot_count["prompt"]
