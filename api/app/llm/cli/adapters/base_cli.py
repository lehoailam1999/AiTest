"""Base AI CLI adapter — session pool + prompt + JSON → TestCaseDraft."""

from __future__ import annotations

import json
import logging
import shutil
from typing import Any

from app.llm.base import (
    GenerateContext,
    TestCaseDraft,
    UnitRequest,
    UnitResult,
    infer_language,
    parse_test_cases_json,
    system_prompt,
    unit_result_from_raw,
    unit_system_prompt,
    unit_user_prompt,
    user_prompt,
)
from app.llm.base_adapter import BaseLLMAdapter
from app.llm.cli.json_parser import clean_and_parse_json_array
from app.llm.cli.process_runner import CLIProcessRunner
from app.llm.cli.session_pool import CLISessionPool
from app.llm.providers import LLMError

logger = logging.getLogger(__name__)


class BaseCLIAdapter(BaseLLMAdapter):
    vendor: str = "cli"
    default_path: str = "cli"
    interactive_args: list[str] = []
    oneshot_args: list[str] = ["-p"]
    prefer_oneshot: bool = True

    def __init__(
        self,
        project_id: str,
        *,
        cli_path: str | None = None,
        cli_args: list[str] | None = None,
        model_name: str | None = None,
    ):
        self.project_id = str(project_id)
        self.cli_path = (cli_path or self.default_path).strip() or self.default_path
        self.cli_args = list(cli_args or [])
        self.model_name = (model_name or "").strip() or None
        self.pool = CLISessionPool()
        self.last_session_key: str | None = None

    def build_command(self, *, oneshot: bool = False) -> list[str]:
        cmd = [self.cli_path]
        # Built-in mode flags first, then user cli_args (so -p is not dropped)
        if oneshot and self.oneshot_args:
            cmd.extend(self.oneshot_args)
        elif not oneshot and self.interactive_args:
            cmd.extend(self.interactive_args)
        if self.cli_args:
            cmd.extend(self.cli_args)
        if self.model_name and self.vendor == "gemini-cli":
            if "--model" not in cmd:
                cmd.extend(["--model", self.model_name])
        if self.vendor == "ollama":
            model = self.model_name or "llama3.2"
            # ollama run <model> — rebuild cleanly
            cmd = [self.cli_path, "run", model]
            if self.cli_args:
                cmd.extend(self.cli_args)
        return cmd

    async def health_check(self) -> bool:
        from pathlib import Path

        path = Path(self.cli_path)
        if path.is_file():
            return True
        return shutil.which(self.cli_path) is not None

    async def generate_test_cases(
        self,
        title: str,
        requirement_text: str,
        *,
        ctx: GenerateContext | None = None,
        topic_scope: str | None = None,
        context: dict[str, Any] | None = None,
    ) -> list[TestCaseDraft]:
        del context
        ctx = ctx or GenerateContext()
        if topic_scope and not ctx.topic_scope:
            ctx.topic_scope = topic_scope

        topic_key = None
        if ctx.topic_scope:
            topic_key = (ctx.topic_scope.splitlines()[0] or "")[:80]
        self.last_session_key = self.pool.get_session_key(self.project_id, topic_key)

        sys_p = system_prompt(ctx)
        usr_p = user_prompt(title, requirement_text, ctx)
        prompt = (
            f"{sys_p}\n\n---\n\n{usr_p}\n\n"
            "Trả về CHỈ JSON hợp lệ (object có testCases hoặc array)."
        )

        raw = await self._run_prompt(prompt, topic_key=topic_key)
        try:
            return parse_test_cases_json(raw)
        except Exception:
            rows = clean_and_parse_json_array(raw)
            wrapped = json.dumps({"testCases": rows}, ensure_ascii=False)
            return parse_test_cases_json(wrapped)

    async def chat(self, system: str, user: str) -> str:
        """Generic system+user prompt via CLI (Knowledge / chat enrich)."""
        prompt = f"{system}\n\n---\n\n{user}"
        topic_key = "knowledge-chat"
        self.last_session_key = self.pool.get_session_key(self.project_id, topic_key)
        return await self._run_prompt(prompt, topic_key=topic_key)

    async def generate_unit(self, req: UnitRequest) -> UnitResult:
        """
        Step 1 Unit Test CLI workflow: sinh code qua AI CLI session,
        path vẫn theo AItest/UnitTest layout (staging Desktop không đổi).
        """
        if not (req.source_code or "").strip():
            raise LLMError("sourceCode is required")
        if not (req.test_case_title or "").strip():
            raise LLMError("test case title is required")

        language = infer_language(req)
        sys_p = unit_system_prompt(
            req.framework,
            language,
            testing_framework=req.testing_framework,
            mock_framework=req.mock_framework,
            assertion_library=req.assertion_library,
        )
        usr_p = unit_user_prompt(req)
        prompt = (
            f"{sys_p}\n\n---\n\n{usr_p}\n\n"
            "Chỉ trả về duy nhất khối mã Unit Test trong fence ``` "
            "(không giải thích, không markdown ngoài code)."
        )
        topic_key = "unit_test_gen"
        self.last_session_key = self.pool.get_session_key(self.project_id, topic_key)
        raw = await self._run_prompt(prompt, topic_key=topic_key)
        try:
            return unit_result_from_raw(raw, req)
        except ValueError as exc:
            raise LLMError(str(exc)) from exc

    async def _run_prompt(self, prompt: str, *, topic_key: str | None) -> str:
        if self.prefer_oneshot:
            try:
                return await self._run_oneshot(prompt)
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                # Auth / quota / hard CLI errors — interactive won't help
                hard = (
                    "usage limit",
                    "unauthorized",
                    "not logged",
                    "authentication",
                    "api key",
                    "spend limit",
                )
                if any(h in msg.lower() for h in hard):
                    logger.error("%s oneshot hard failure: %s", self.vendor, e)
                    raise
                logger.warning("%s oneshot failed, try interactive: %s", self.vendor, e)

        cmd = self.build_command(oneshot=False)
        runner = await self.pool.get_or_create_session(
            self.project_id,
            topic_key,
            cmd,
            interactive=True,
            send_system_init=True,
        )
        return await runner.send_prompt(prompt)

    async def _run_oneshot(self, prompt: str) -> str:
        """
        gemini/claude -p expect prompt as CLI arg (not only stdin).
        Long prompts (>6000 chars) use stdin to avoid Windows cmdline limit.
        """
        cmd = self.build_command(oneshot=True)
        uses_p = any(a in ("-p", "--prompt", "--print") for a in cmd)
        if uses_p and len(prompt) <= 6000:
            runner = CLIProcessRunner(command=[*cmd, prompt])
            return await runner.run_oneshot("")
        # stdin (ollama run, custom script, or long -p prompts)
        runner = CLIProcessRunner(command=cmd)
        return await runner.run_oneshot(prompt)
