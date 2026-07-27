"""Tests for ProjectInspector (Step 2 Unit Test CLI workflow)."""

from __future__ import annotations

import json
from pathlib import Path

from app.services.project_inspector import (
    ProjectInspector,
    apply_stack_to_generate_fields,
)


def test_inspect_node_vitest(tmp_path: Path):
    (tmp_path / "package.json").write_text(
        json.dumps(
            {
                "name": "demo",
                "devDependencies": {"vitest": "^1.0.0"},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "tsconfig.json").write_text("{}", encoding="utf-8")
    src = tmp_path / "src"
    src.mkdir()
    (src / "auth.ts").write_text("export const x = 1;\n", encoding="utf-8")

    info = ProjectInspector.inspect_project(
        str(tmp_path),
        source_relative_path="src/auth.ts",
        module="Auth",
    )
    assert info.language == "TypeScript"
    assert info.framework == "vitest"
    assert "vitest" in info.run_command
    assert info.test_dir.startswith("AItest/")
    assert info.suggested_unit_path
    assert "AItest" in info.suggested_unit_path.replace("\\", "/")
    assert info.suggested_file_name


def test_inspect_python_pytest(tmp_path: Path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
    info = ProjectInspector.inspect_project(str(tmp_path), source_relative_path="app/main.py")
    assert info.language == "Python"
    assert info.framework == "pytest"
    assert info.run_command[0] == "pytest"


def test_inspect_monorepo_package(tmp_path: Path):
    (tmp_path / "pnpm-workspace.yaml").write_text("packages:\n  - 'packages/*'\n", encoding="utf-8")
    pkg = tmp_path / "packages" / "auth-service"
    pkg.mkdir(parents=True)
    (pkg / "package.json").write_text(
        json.dumps({"name": "@org/auth", "devDependencies": {"jest": "^29.0.0"}}),
        encoding="utf-8",
    )
    src = pkg / "src"
    src.mkdir()
    (src / "token.ts").write_text("export {}\n", encoding="utf-8")

    info = ProjectInspector.inspect_project(
        str(tmp_path),
        source_relative_path="packages/auth-service/src/token.ts",
    )
    assert info.is_monorepo_package is True
    assert info.package_name == "@org/auth"
    assert info.run_command[:3] == ["pnpm", "--filter", "@org/auth"]


def test_apply_stack_fills_auto():
    from app.services.project_inspector import StackInspect

    stack = StackInspect(
        language="C#",
        framework="xunit",
        test_dir="AItest/UnitTest",
        native_test_dir="tests",
        run_command=["dotnet", "test"],
        file_extension="Tests.cs",
    )
    lang, fw, tfw = apply_stack_to_generate_fields(
        language="auto",
        framework="",
        testing_framework="auto",
        stack=stack,
    )
    assert lang == "C#"
    assert fw == "xunit"
    assert tfw == "xunit"

    lang2, fw2, _ = apply_stack_to_generate_fields(
        language="TypeScript",
        framework="vitest",
        testing_framework="vitest",
        stack=stack,
    )
    assert lang2 == "TypeScript"
    assert fw2 == "vitest"


def test_csharp_source_overrides_node_mashup(tmp_path: Path):
    (tmp_path / "package.json").write_text(
        json.dumps({"devDependencies": {"jest": "29"}}), encoding="utf-8"
    )
    (tmp_path / "Foo.cs").write_text("class Foo {}\n", encoding="utf-8")
    info = ProjectInspector.inspect_project(str(tmp_path), source_relative_path="Foo.cs")
    assert info.language == "C#"
    assert info.framework == "xunit"
