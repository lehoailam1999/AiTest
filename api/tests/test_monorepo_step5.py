"""Step 5 — Monorepo package isolation & targeted commands."""

from __future__ import annotations

import json
from pathlib import Path

from app.services.monorepo_inspector import (
    MonorepoInspector,
    detect_workspace_kind,
    shell_join,
)
from app.services.project_inspector import ProjectInspector


def test_detect_pnpm_workspace(tmp_path: Path):
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - 'packages/*'\n", encoding="utf-8")
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    assert detect_workspace_kind(tmp_path) == "pnpm"


def test_detect_nx(tmp_path: Path):
    (tmp_path / "nx.json").write_text("{}", encoding="utf-8")
    assert detect_workspace_kind(tmp_path) == "nx"


def test_resolve_pnpm_filter_command(tmp_path: Path):
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - 'packages/*'\n", encoding="utf-8")
    pkg = tmp_path / "packages" / "auth-service"
    pkg.mkdir(parents=True)
    (pkg / "package.json").write_text(
        json.dumps({"name": "@org/auth", "devDependencies": {"jest": "29"}}),
        encoding="utf-8",
    )
    (pkg / "src").mkdir()
    (pkg / "src" / "token.ts").write_text("export {}\n", encoding="utf-8")

    mono = MonorepoInspector.resolve(
        str(tmp_path), "packages/auth-service/src/token.ts"
    )
    assert mono.is_monorepo is True
    assert mono.workspace_kind == "pnpm"
    assert mono.package_name == "@org/auth"
    assert mono.package_root == "packages/auth-service"
    assert mono.test_command == ["pnpm", "--filter", "@org/auth", "test"]
    assert "--coverage" in mono.coverage_command
    assert "pnpm --filter @org/auth test" == shell_join(mono.test_command)


def test_resolve_maven_pl(tmp_path: Path):
    (tmp_path / "pom.xml").write_text(
        "<project><modules><module>services/auth</module></modules></project>",
        encoding="utf-8",
    )
    svc = tmp_path / "services" / "auth"
    svc.mkdir(parents=True)
    (svc / "pom.xml").write_text("<project/>", encoding="utf-8")
    (svc / "src" / "main" / "java").mkdir(parents=True)
    (svc / "src" / "main" / "java" / "A.java").write_text("class A {}", encoding="utf-8")

    mono = MonorepoInspector.resolve(str(tmp_path), "services/auth/src/main/java/A.java")
    assert mono.is_monorepo is True
    assert mono.workspace_kind == "maven"
    assert mono.package_root == "services/auth"
    assert "-pl" in mono.test_command
    assert "services/auth" in mono.test_command


def test_resolve_gradle_path(tmp_path: Path):
    (tmp_path / "settings.gradle").write_text("include 'services:billing'\n", encoding="utf-8")
    svc = tmp_path / "services" / "billing"
    svc.mkdir(parents=True)
    (svc / "build.gradle").write_text("plugins {}\n", encoding="utf-8")
    (svc / "src").mkdir()
    (svc / "src" / "X.java").write_text("class X {}", encoding="utf-8")

    mono = MonorepoInspector.resolve(str(tmp_path), "services/billing/src/X.java")
    assert mono.workspace_kind == "gradle"
    assert any(":services:billing:test" in c for c in mono.test_command)


def test_resolve_python_package(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='mono'\n", encoding="utf-8")
    (tmp_path / "packages").mkdir()
    pkg = tmp_path / "packages" / "payments"
    pkg.mkdir()
    (pkg / "pyproject.toml").write_text("[project]\nname='payments'\n", encoding="utf-8")
    (pkg / "tests").mkdir()
    (pkg / "src").mkdir()
    (pkg / "src" / "pay.py").write_text("x=1\n", encoding="utf-8")

    mono = MonorepoInspector.resolve(str(tmp_path), "packages/payments/src/pay.py")
    assert mono.is_monorepo is True
    assert mono.workspace_kind == "python"
    assert mono.package_root == "packages/payments"
    assert "packages/payments" in " ".join(mono.test_command)


def test_resolve_go_workspace(tmp_path: Path):
    (tmp_path / "go.work").write_text("go 1.22\n", encoding="utf-8")
    pkg = tmp_path / "packages" / "lib"
    pkg.mkdir(parents=True)
    (pkg / "go.mod").write_text("module example.com/lib\n", encoding="utf-8")
    (pkg / "lib.go").write_text("package lib\n", encoding="utf-8")

    mono = MonorepoInspector.resolve(str(tmp_path), "packages/lib/lib.go")
    assert mono.workspace_kind == "go"
    assert any("packages/lib" in c for c in mono.test_command)


def test_nested_backend_without_workspaces_uses_local_npm(tmp_path: Path):
    """TestIDE/backend layout — no package.json#workspaces → npm test (not -w)."""
    backend = tmp_path / "backend"
    backend.mkdir()
    (backend / "package.json").write_text(
        json.dumps({"name": "backend", "scripts": {"test": "jest"}, "devDependencies": {"jest": "29"}}),
        encoding="utf-8",
    )
    (backend / "src").mkdir()
    (backend / "src" / "app.service.ts").write_text("export class App {}\n", encoding="utf-8")

    mono = MonorepoInspector.resolve(str(tmp_path), "backend/src/app.service.ts")
    assert mono.is_monorepo is True
    assert mono.package_root == "backend"
    assert mono.workspace_kind == "node"
    joined = shell_join(mono.test_command)
    assert "-w" not in joined
    assert "--workspace" not in joined
    assert mono.test_command[:2] == ["npx", "jest"]


def test_npm_workspaces_still_uses_w_flag(tmp_path: Path):
    (tmp_path / "package.json").write_text(
        json.dumps({"private": True, "workspaces": ["packages/*"]}),
        encoding="utf-8",
    )
    pkg = tmp_path / "packages" / "api"
    pkg.mkdir(parents=True)
    (pkg / "package.json").write_text(
        json.dumps({"name": "api", "devDependencies": {"jest": "29"}}),
        encoding="utf-8",
    )
    (pkg / "src").mkdir()
    (pkg / "src" / "a.ts").write_text("export {}\n", encoding="utf-8")

    mono = MonorepoInspector.resolve(str(tmp_path), "packages/api/src/a.ts")
    assert mono.workspace_kind == "npm"
    assert "-w" in mono.test_command
    assert "api" in mono.test_command


def test_project_inspector_overlays_pnpm(tmp_path: Path):
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - 'packages/*'\n", encoding="utf-8")
    pkg = tmp_path / "packages" / "auth-service"
    pkg.mkdir(parents=True)
    (pkg / "package.json").write_text(
        json.dumps({"name": "@org/auth", "devDependencies": {"vitest": "^1.0.0"}}),
        encoding="utf-8",
    )
    (pkg / "tsconfig.json").write_text("{}", encoding="utf-8")
    (pkg / "src").mkdir()
    (pkg / "src" / "token.ts").write_text("export {}\n", encoding="utf-8")

    info = ProjectInspector.inspect_project(
        str(tmp_path),
        source_relative_path="packages/auth-service/src/token.ts",
    )
    assert info.is_monorepo_package is True
    assert info.workspace_kind == "pnpm"
    assert info.run_command[:3] == ["pnpm", "--filter", "@org/auth"]
    assert info.coverage_command
    assert info.package_name == "@org/auth"


def test_turbo_filter(tmp_path: Path):
    (tmp_path / "turbo.json").write_text("{}", encoding="utf-8")
    app = tmp_path / "apps" / "web"
    app.mkdir(parents=True)
    (app / "package.json").write_text(
        json.dumps({"name": "web", "devDependencies": {"jest": "29"}}),
        encoding="utf-8",
    )
    (app / "src").mkdir()
    (app / "src" / "a.ts").write_text("export {}\n", encoding="utf-8")

    mono = MonorepoInspector.resolve(str(tmp_path), "apps/web/src/a.ts")
    assert mono.workspace_kind == "turbo"
    assert mono.test_command[:3] == ["npx", "turbo", "run"]
    assert any(c.startswith("--filter=") for c in mono.test_command)
