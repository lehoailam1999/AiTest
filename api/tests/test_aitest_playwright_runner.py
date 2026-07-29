"""Shared AITest Playwright runner (~/.aitest/playwright-runner)."""

from __future__ import annotations

import json
from pathlib import Path

from app.services.aitest_playwright_runner import (
    probe_shared_runner,
    shared_playwright_runner_dir,
)
from app.services.e2e_orchestrator import (
    check_playwright_ready,
    default_playwright_run_command,
)


def test_probe_shared_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("AITEST_HOME", str(tmp_path / "home"))
    st = probe_shared_runner()
    assert st.ok is False
    assert st.installed is False
    assert "playwright-runner" in st.runner_dir.replace("\\", "/")


def test_probe_shared_installed(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("AITEST_HOME", str(home))
    runner = shared_playwright_runner_dir()
    nm = runner / "node_modules" / "@playwright" / "test"
    nm.mkdir(parents=True)
    (nm / "package.json").write_text("{}", encoding="utf-8")
    st = probe_shared_runner()
    assert st.ok is True
    assert st.installed is True


def test_check_falls_back_to_aitest_runner(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("AITEST_HOME", str(home))
    runner = shared_playwright_runner_dir()
    nm = runner / "node_modules" / "@playwright" / "test"
    nm.mkdir(parents=True)
    (nm / "package.json").write_text("{}", encoding="utf-8")

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "package.json").write_text(json.dumps({"name": "app"}), encoding="utf-8")

    check = check_playwright_ready(str(proj))
    # needs npx on PATH for ok=True
    import shutil

    if shutil.which("npx") or shutil.which("npx.cmd"):
        assert check.ok is True
        assert check.source == "aitest"
        assert check.package_root is not None
    else:
        assert check.has_package is True or check.source in ("aitest", "none")


def test_default_cmd_with_runner_prefix():
    cmd = default_playwright_run_command(
        "specs/a.spec.ts",
        runner_prefix=r"C:\Users\x\.aitest\playwright-runner",
    )
    assert cmd[0] == "npx"
    assert "--prefix" in cmd
    assert "playwright" in cmd
    assert "specs/a.spec.ts" in cmd
