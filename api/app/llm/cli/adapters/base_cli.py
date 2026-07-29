"""Base AI CLI adapter — session pool + prompt + JSON → TestCaseDraft."""

from __future__ import annotations

import json
import logging
import shutil
from typing import Any

from app.llm.base import (
    E2ERequest,
    E2EResult,
    GenerateContext,
    TestCaseDraft,
    UnitRequest,
    UnitResult,
    e2e_result_from_raw,
    e2e_system_prompt,
    e2e_user_prompt,
    infer_language,
    parse_test_cases_json,
    system_prompt,
    unit_result_from_raw,
    unit_system_prompt,
    unit_user_prompt,
    user_prompt,
)
from app.llm.base_adapter import BaseLLMAdapter, ProgressCb
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
        self._on_progress: ProgressCb | None = None

    def _progress(self, message: str) -> None:
        if self._on_progress:
            try:
                self._on_progress(message)
            except Exception:  # noqa: BLE001
                pass

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
        on_progress: ProgressCb | None = None,
        prefer_oneshot: bool | None = None,
        session_topic_key: str | None = None,
    ) -> list[TestCaseDraft]:
        del context
        self._on_progress = on_progress
        ctx = ctx or GenerateContext()
        if topic_scope and not ctx.topic_scope:
            ctx.topic_scope = topic_scope

        topic_key = session_topic_key
        if topic_key is None and ctx.topic_scope:
            topic_key = (ctx.topic_scope.splitlines()[0] or "")[:80]
        self.last_session_key = self.pool.get_session_key(self.project_id, topic_key)

        sys_p = system_prompt(ctx)
        usr_p = user_prompt(title, requirement_text, ctx)
        prompt = (
            f"{sys_p}\n\n---\n\n{usr_p}\n\n"
            "Trả về CHỈ JSON hợp lệ (object có testCases hoặc array)."
        )

        # Nhật ký: mô tả hệ thống đang gửi gì (không dump full prompt)
        scope_line = (ctx.topic_scope or "").splitlines()[0] if ctx.topic_scope else ""
        feat = ", ".join((ctx.feature_titles or [])[:6]) or "(all)"
        src_len = len(ctx.source_context or "")
        self._progress("--- PROMPT GỬI AI CLI ---")
        self._progress(
            f"vendor={self.vendor} | project={self.project_id} | "
            f"mode={ctx.mode} | content_ver=v{ctx.content_version}"
        )
        self._progress(
            f"title={title[:120]} | modules=[{feat}] | "
            f"topic={scope_line[:100] or '(none)'} | existing_tc={len(ctx.existing_cases or [])}"
        )
        self._progress(
            f"sizes: system={len(sys_p):,} | user={len(usr_p):,} | "
            f"source_ctx={src_len:,} | total_prompt={len(prompt):,} chars"
        )
        # Preview đầu system + user để người dùng thấy đang yêu cầu gì
        sys_preview = "\n".join(sys_p.splitlines()[:8])
        usr_preview = "\n".join(usr_p.splitlines()[:14])
        self._progress(f"[system preview]\n{sys_preview}\n…")
        self._progress(f"[user preview]\n{usr_preview}\n…")
        self._progress(f"AI CLI ({self.vendor}): đang gửi prompt (~{len(prompt):,} ký tự)…")
        raw = await self._run_prompt(
            prompt, topic_key=topic_key, prefer_oneshot=prefer_oneshot
        )
        self._progress(
            f"AI CLI ({self.vendor}): đã nhận phản hồi (~{len(raw):,} ký tự), đang parse JSON…"
        )
        raw_preview = (raw or "").strip()[:500].replace("\r", "")
        if raw_preview:
            self._progress(f"[response preview]\n{raw_preview}\n…")
        try:
            drafts = parse_test_cases_json(raw)
            self._progress(f"Parse OK — {len(drafts)} test case")
            return drafts
        except Exception:
            rows = clean_and_parse_json_array(raw)
            wrapped = json.dumps({"testCases": rows}, ensure_ascii=False)
            drafts = parse_test_cases_json(wrapped)
            self._progress(f"Parse (salvage) OK — {len(drafts)} test case")
            return drafts

    async def chat(self, system: str, user: str) -> str:
        """Generic system+user prompt via CLI (Knowledge / chat enrich)."""
        prompt = f"{system}\n\n---\n\n{user}"
        topic_key = "knowledge-chat"
        self.last_session_key = self.pool.get_session_key(self.project_id, topic_key)
        return await self._run_prompt(prompt, topic_key=topic_key)

    async def generate_e2e(self, req: E2ERequest, *, heal: bool = False) -> E2EResult:
        """
        E2E Playwright codegen via CLI.

        Prefer warm interactive session for most CLIs (avoid cold start per TC).
        Cursor Agent must stay on oneshot ``--mode ask`` so it cannot write into
        the AITest product workspace; host applies files under projectRoot only.
        """
        sys_p = e2e_system_prompt(heal=heal)
        usr_p = e2e_user_prompt(req)
        prompt = (
            f"{sys_p}\n\n---\n\n{usr_p}\n\n"
            "Output only ### FILE: sections with full file contents (no prose). "
            "Do NOT create or edit any files on disk — return text only."
        )
        topic_key = "e2e_test_heal" if heal else "e2e_test_gen"
        self.last_session_key = self.pool.get_session_key(self.project_id, topic_key)
        prefer_oneshot = self.vendor == "cursor-cli"
        raw = await self._run_prompt(
            prompt, topic_key=topic_key, prefer_oneshot=prefer_oneshot
        )
        try:
            return e2e_result_from_raw(raw, req)
        except ValueError as exc:
            raise LLMError(str(exc)) from exc

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

    async def _run_prompt(
        self,
        prompt: str,
        *,
        topic_key: str | None,
        prefer_oneshot: bool | None = None,
    ) -> str:
        use_oneshot = self.prefer_oneshot if prefer_oneshot is None else prefer_oneshot
        # Cursor Agent must stay oneshot --mode ask (interactive can write the workspace).
        if self.vendor == "cursor-cli":
            use_oneshot = True
        if use_oneshot:
            try:
                self._progress(f"AI CLI ({self.vendor}): oneshot — đang chờ model…")
                return await self._run_oneshot(prompt)
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                low = msg.lower()
                # Auth / quota / hard CLI errors — interactive won't help
                hard = (
                    "usage limit",
                    "unauthorized",
                    "not logged",
                    "authentication",
                    "api key",
                    "spend limit",
                )
                if any(h in low for h in hard):
                    logger.error("%s oneshot hard failure: %s", self.vendor, e)
                    raise
                # Timeout / hung oneshot — fail fast (do not burn another 3–10 min on interactive)
                timed_out = (
                    isinstance(e, TimeoutError)
                    or "timed out" in low
                    or "timeout" in low
                )
                if timed_out:
                    logger.error("%s oneshot timeout (no interactive fallback): %s", self.vendor, e)
                    self._progress(
                        f"AI CLI ({self.vendor}): oneshot hết thời gian — dừng (không fallback interactive)."
                    )
                    raise
                logger.warning("%s oneshot failed, try interactive: %s", self.vendor, e)
                self._progress(
                    f"AI CLI ({self.vendor}): oneshot lỗi, thử session interactive…"
                )

        cmd = self.build_command(oneshot=False)
        self._progress(f"AI CLI ({self.vendor}): session interactive…")
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
