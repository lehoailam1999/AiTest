"""
Shared Playwright runner owned by AITest (not the user project).

Install once under ``~/.aitest/playwright-runner`` → Headless dùng
``npx --prefix <runner> playwright test`` với cwd = module E2E trong project.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from app.llm.cli.process_runner import _CREATE_NO_WINDOW

logger = logging.getLogger(__name__)

RUNNER_PACKAGE_JSON = {
    "name": "aitest-playwright-runner",
    "version": "1.0.0",
    "private": True,
    "description": "AITest shared @playwright/test + Chromium (not the SUT project)",
    "devDependencies": {
        "@playwright/test": "^1.51.0",
    },
}


@dataclass
class SharedRunnerStatus:
    ok: bool
    runner_dir: str
    message: str
    installed: bool


def aitest_home() -> Path:
    override = (os.environ.get("AITEST_HOME") or "").strip()
    if override:
        return Path(override)
    return Path.home() / ".aitest"


def shared_playwright_runner_dir() -> Path:
    return aitest_home() / "playwright-runner"


def shared_playwright_installed(runner_dir: Path | None = None) -> bool:
    root = runner_dir or shared_playwright_runner_dir()
    return (root / "node_modules" / "@playwright" / "test").is_dir()


def _ensure_dump_script(runner: Path) -> None:
    """Copy Inspect dump-html.mjs next to the shared runner."""
    src = Path(__file__).with_name("playwright_dump_html.mjs")
    dst = runner / "dump-html.mjs"
    if src.is_file():
        dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")


def _run_shell(cmd: str, *, cwd: Path) -> tuple[int, str]:
    kwargs: dict = {
        "cwd": str(cwd),
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "env": os.environ.copy(),
    }
    if sys.platform == "win32":
        if _CREATE_NO_WINDOW:
            kwargs["creationflags"] = _CREATE_NO_WINDOW
        completed = subprocess.run(  # noqa: S603
            ["cmd", "/C", cmd],
            **kwargs,
        )
    else:
        completed = subprocess.run(  # noqa: S603
            ["sh", "-c", cmd],
            **kwargs,
        )
    out = (completed.stdout or b"").decode("utf-8", errors="replace")
    err = (completed.stderr or b"").decode("utf-8", errors="replace")
    return int(completed.returncode or 0), f"{out}\n{err}".strip()


def ensure_shared_playwright_runner(
    *,
    install_browsers: bool = True,
    force: bool = False,
) -> SharedRunnerStatus:
    """
    Create ~/.aitest/playwright-runner and install @playwright/test (+ Chromium).
    Idempotent unless force=True.
    """
    runner = shared_playwright_runner_dir()
    runner.mkdir(parents=True, exist_ok=True)
    pkg = runner / "package.json"
    if not pkg.is_file():
        pkg.write_text(
            json.dumps(RUNNER_PACKAGE_JSON, indent=2) + "\n",
            encoding="utf-8",
        )

    if shared_playwright_installed(runner) and not force:
        _ensure_dump_script(runner)
        return SharedRunnerStatus(
            ok=True,
            runner_dir=str(runner),
            message=f"AITest Playwright ready tại `{runner}`",
            installed=True,
        )

    if not (shutil.which("npx") or shutil.which("npx.cmd") or shutil.which("npm")):
        return SharedRunnerStatus(
            ok=False,
            runner_dir=str(runner),
            message="Không tìm thấy npm/npx — cài Node.js rồi thử lại.",
            installed=False,
        )

    code, log = _run_shell("npm install", cwd=runner)
    if code != 0:
        return SharedRunnerStatus(
            ok=False,
            runner_dir=str(runner),
            message=f"npm install thất bại trong AITest runner:\n{log[-1500:]}",
            installed=False,
        )

    if install_browsers:
        # Prefer local CLI after install
        code2, log2 = _run_shell("npx playwright install chromium", cwd=runner)
        if code2 != 0:
            return SharedRunnerStatus(
                ok=False,
                runner_dir=str(runner),
                message=(
                    f"Đã có @playwright/test nhưng cài Chromium thất bại:\n{log2[-1500:]}"
                ),
                installed=shared_playwright_installed(runner),
            )

    ok = shared_playwright_installed(runner)
    if ok:
        _ensure_dump_script(runner)
    return SharedRunnerStatus(
        ok=ok,
        runner_dir=str(runner),
        message=(
            f"Đã cài Playwright Chromium cho AITest tại `{runner}`"
            if ok
            else f"Cài chưa đủ — thiếu node_modules/@playwright/test tại `{runner}`"
        ),
        installed=ok,
    )


def playwright_cli_via_shared_runner(
    spec_arg: str,
    *,
    config_arg: str | None = None,
    runner_dir: str | None = None,
    headed: bool = False,
) -> list[str]:
    """
    Invoke Playwright via ``node <runner>/node_modules/@playwright/test/cli.js``.

    Avoid ``npx`` on Windows: ``resolve_command`` may wrap ``npx.cmd`` through
    ``powershell.exe``, which resets cwd to
    ``C:\\Windows\\System32\\WindowsPowerShell\\v1.0`` and breaks config discovery.
    """
    prefix = Path(runner_dir or str(shared_playwright_runner_dir())).resolve()
    cli = prefix / "node_modules" / "@playwright" / "test" / "cli.js"
    node = shutil.which("node") or "node"
    if not cli.is_file():
        # Fallback — only used when runner is incomplete; prefer node path above.
        cmd = [
            "npx",
            "-y",
            "--prefix",
            str(prefix),
            "playwright",
            "test",
            spec_arg.replace("\\", "/"),
            "--reporter=json",
            "--workers=1",
        ]
    else:
        cmd = [
            node,
            str(cli),
            "test",
            spec_arg.replace("\\", "/"),
            "--reporter=json",
            "--workers=1",
        ]
    if headed:
        cmd.append("--headed")
    if config_arg:
        cmd.extend(["--config", str(Path(config_arg))])
    return cmd


def probe_shared_runner() -> SharedRunnerStatus:
    runner = shared_playwright_runner_dir()
    if shared_playwright_installed(runner):
        return SharedRunnerStatus(
            ok=True,
            runner_dir=str(runner),
            message=f"AITest Playwright ready tại `{runner}`",
            installed=True,
        )
    return SharedRunnerStatus(
        ok=False,
        runner_dir=str(runner),
        message=(
            f"Chưa cài Playwright trên AITest (`{runner}`). "
            "Bấm «Cài Playwright trên AITest» để dùng Chromium dùng chung."
        ),
        installed=False,
    )
