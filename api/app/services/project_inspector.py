"""
Project Standard Inspector — Step 2 Unit Test CLI workflow.

Nhận diện ngôn ngữ / test framework / lệnh chạy từ manifest trên disk.
Path sinh file vẫn theo layout sản phẩm AItest/UnitTest/… (không mkdir native).
Step 5 — lệnh khoanh vùng monorepo qua MonorepoInspector.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from app.services.monorepo_inspector import MonorepoInspector, find_package_root
from app.services.test_output_layout import (
    aitest_kind_root,
    file_name_from_source,
    under_generated_test_folder,
)

logger = logging.getLogger(__name__)


@dataclass
class StackInspect:
    language: str
    framework: str
    """Relative test dir for product layout (AItest/UnitTest)."""
    test_dir: str
    """Native convention hint (src/__tests__, tests/, …) — Step 3+."""
    native_test_dir: str
    run_command: list[str]
    file_extension: str
    manifest: str = ""
    package_root: str = ""
    package_name: str = "root"
    is_monorepo_package: bool = False
    """Step 5 — pnpm|turbo|nx|maven|…|none"""
    workspace_kind: str = "none"
    coverage_command: list[str] = field(default_factory=list)
    compile_command: list[str] = field(default_factory=list)
    """Suggested relative path under AItest for this source (optional)."""
    suggested_unit_path: str | None = None
    suggested_file_name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _rel(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def _find_csproj(root: Path) -> Path | None:
    """Prefer shallow csproj — avoid deep ** recursion on huge repos."""
    for p in sorted(root.glob("*.csproj")):
        return p
    for p in sorted(root.glob("*/*.csproj")):
        return p
    for p in sorted(root.glob("src/*/*.csproj")):
        return p
    for p in sorted(root.glob("tests/*/*.csproj")):
        return p
    return None


def _walk_package_root(project_root: Path, source_relative: str | None) -> Path:
    """Nearest package/module root for source (monorepo-aware)."""
    return find_package_root(project_root, source_relative)


def _apply_monorepo_commands(
    info: StackInspect, root: Path, source_relative: str | None
) -> StackInspect:
    """Overlay Step 5 targeted commands onto stack inspect."""
    try:
        mono = MonorepoInspector.resolve(str(root), source_relative)
    except ValueError:
        return info
    info.workspace_kind = mono.workspace_kind
    info.package_name = mono.package_name or info.package_name
    info.package_root = mono.package_root
    info.is_monorepo_package = mono.is_monorepo
    if mono.test_command:
        info.run_command = list(mono.test_command)
    if mono.coverage_command:
        info.coverage_command = list(mono.coverage_command)
    if mono.compile_command:
        info.compile_command = list(mono.compile_command)
    if mono.framework_hint and info.language in ("TypeScript", "JavaScript"):
        if mono.framework_hint in ("jest", "vitest", "mocha"):
            info.framework = mono.framework_hint
    return info


def _inspect_node(root: Path, package_root: Path) -> StackInspect:
    pkg_path = package_root / "package.json"
    pkg = _read_json(pkg_path) if pkg_path.is_file() else {}
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    framework = "jest"
    if "vitest" in deps:
        framework = "vitest"
    elif "mocha" in deps:
        framework = "mocha"
    is_ts = (package_root / "tsconfig.json").is_file()
    language = "TypeScript" if is_ts else "JavaScript"
    if (package_root / "src" / "__tests__").is_dir():
        native = "src/__tests__"
    elif (package_root / "tests").is_dir():
        native = "tests"
    elif (package_root / "__tests__").is_dir():
        native = "__tests__"
    else:
        native = "src/__tests__" if is_ts else "tests"
    if framework == "vitest":
        run_cmd = ["npx", "vitest", "run"]
        cov_cmd = ["npx", "vitest", "run", "--coverage"]
    else:
        run_cmd = ["npm", "test"]
        cov_cmd = ["npm", "test", "--", "--coverage"]
    return StackInspect(
        language=language,
        framework=framework,
        test_dir=aitest_kind_root("unit"),
        native_test_dir=native,
        run_command=run_cmd,
        file_extension=".spec.ts" if is_ts else ".test.js",
        manifest="package.json",
        package_root=_rel(root, package_root) if package_root != root else "",
        package_name=str(pkg.get("name") or package_root.name),
        is_monorepo_package=package_root.resolve() != root.resolve(),
        coverage_command=cov_cmd,
    )


def _inspect_python(root: Path, package_root: Path) -> StackInspect:
    cov = [
        "pytest",
        "--cov=.",
        "--cov-report=xml:coverage.xml",
        "--junitxml=report.xml",
    ]
    return StackInspect(
        language="Python",
        framework="pytest",
        test_dir=aitest_kind_root("unit"),
        native_test_dir="tests",
        run_command=["pytest"],
        file_extension="_test.py",
        manifest=(
            "pyproject.toml"
            if (package_root / "pyproject.toml").is_file()
            else "pytest.ini"
            if (package_root / "pytest.ini").is_file()
            else "requirements.txt"
        ),
        package_root=_rel(root, package_root) if package_root != root else "",
        package_name=package_root.name,
        is_monorepo_package=package_root.resolve() != root.resolve(),
        coverage_command=cov,
    )


def _inspect_java(root: Path, package_root: Path) -> StackInspect:
    is_maven = (package_root / "pom.xml").is_file()
    if is_maven:
        cmd = ["./mvnw", "test"] if (package_root / "mvnw").is_file() else ["mvn", "test"]
        compile_cmd = (
            ["./mvnw", "-q", "-DskipTests", "compile"]
            if (package_root / "mvnw").is_file()
            else ["mvn", "-q", "-DskipTests", "compile"]
        )
        manifest = "pom.xml"
    else:
        cmd = ["./gradlew", "test"] if (package_root / "gradlew").is_file() else [
            "gradle",
            "test",
        ]
        compile_cmd = (
            ["./gradlew", "compileJava"]
            if (package_root / "gradlew").is_file()
            else ["gradle", "compileJava"]
        )
        manifest = (
            "build.gradle.kts"
            if (package_root / "build.gradle.kts").is_file()
            else "build.gradle"
        )
    return StackInspect(
        language="Java",
        framework="junit5",
        test_dir=aitest_kind_root("unit"),
        native_test_dir="src/test/java",
        run_command=cmd,
        file_extension="Test.java",
        manifest=manifest,
        package_root=_rel(root, package_root) if package_root != root else "",
        package_name=package_root.name,
        is_monorepo_package=package_root.resolve() != root.resolve(),
        coverage_command=list(cmd),
        compile_command=compile_cmd,
    )


def _inspect_csharp(root: Path, package_root: Path) -> StackInspect:
    return StackInspect(
        language="C#",
        framework="xunit",
        test_dir=aitest_kind_root("unit"),
        native_test_dir="tests",
        run_command=["dotnet", "test"],
        file_extension="Tests.cs",
        manifest="*.csproj",
        package_root=_rel(root, package_root) if package_root != root else "",
        package_name=package_root.name,
        is_monorepo_package=package_root.resolve() != root.resolve(),
        coverage_command=[
            "dotnet",
            "test",
            "--logger:trx",
            "--collect:XPlat Code Coverage",
        ],
        compile_command=["dotnet", "build"],
    )


def _inspect_go(root: Path, package_root: Path) -> StackInspect:
    return StackInspect(
        language="Go",
        framework="testing",
        test_dir=aitest_kind_root("unit"),
        native_test_dir=".",
        run_command=["go", "test", "-v", "./..."],
        file_extension="_test.go",
        manifest="go.mod",
        package_root=_rel(root, package_root) if package_root != root else "",
        package_name=package_root.name,
        is_monorepo_package=package_root.resolve() != root.resolve(),
        coverage_command=["go", "test", "-v", "-coverprofile=coverage.out", "./..."],
    )


def _inspect_rust(root: Path, package_root: Path) -> StackInspect:
    return StackInspect(
        language="Rust",
        framework="cargo",
        test_dir=aitest_kind_root("unit"),
        native_test_dir="tests",
        run_command=["cargo", "test"],
        file_extension="_test.rs",
        manifest="Cargo.toml",
        package_root=_rel(root, package_root) if package_root != root else "",
        package_name=package_root.name,
        is_monorepo_package=package_root.resolve() != root.resolve(),
        coverage_command=["cargo", "test"],
    )


def _inspect_php(root: Path, package_root: Path) -> StackInspect:
    return StackInspect(
        language="PHP",
        framework="phpunit",
        test_dir=aitest_kind_root("unit"),
        native_test_dir="tests/Unit",
        run_command=["./vendor/bin/phpunit"],
        file_extension="Test.php",
        manifest="composer.json",
        package_root=_rel(root, package_root) if package_root != root else "",
        package_name=package_root.name,
        is_monorepo_package=package_root.resolve() != root.resolve(),
        coverage_command=["./vendor/bin/phpunit", "--coverage-clover", "coverage.xml"],
    )


def _inspect_at(root: Path, package_root: Path) -> StackInspect:
    if (package_root / "package.json").is_file():
        return _inspect_node(root, package_root)
    if (
        (package_root / "pyproject.toml").is_file()
        or (package_root / "pytest.ini").is_file()
        or (package_root / "requirements.txt").is_file()
        or (package_root / "setup.py").is_file()
    ):
        return _inspect_python(root, package_root)
    if (package_root / "pom.xml").is_file() or (package_root / "build.gradle").is_file() or (
        package_root / "build.gradle.kts"
    ).is_file():
        return _inspect_java(root, package_root)
    if _find_csproj(package_root) or list(package_root.glob("*.sln")):
        return _inspect_csharp(root, package_root)
    if (package_root / "go.mod").is_file():
        return _inspect_go(root, package_root)
    if (package_root / "Cargo.toml").is_file():
        return _inspect_rust(root, package_root)
    if (package_root / "composer.json").is_file() or (package_root / "phpunit.xml").is_file():
        return _inspect_php(root, package_root)
    return StackInspect(
        language="generic",
        framework="custom",
        test_dir=aitest_kind_root("unit"),
        native_test_dir="tests",
        run_command=[],
        file_extension=".test.txt",
        manifest="",
        package_root=_rel(root, package_root) if package_root != root else "",
        package_name=package_root.name,
        is_monorepo_package=package_root.resolve() != root.resolve(),
    )


class ProjectInspector:
    """Tự động phát hiện stack + gợi ý path AItest (không tạo thư mục)."""

    @staticmethod
    def inspect_project(
        project_root: str,
        *,
        source_relative_path: str | None = None,
        module: str = "",
        package_prefix: str | None = None,
    ) -> StackInspect:
        root = Path(project_root)
        if not root.exists():
            raise ValueError(f"Đường dẫn dự án không tồn tại: {project_root}")
        if not root.is_dir():
            raise ValueError(f"projectRoot không phải thư mục: {project_root}")

        package_root = _walk_package_root(root, source_relative_path)
        info = _inspect_at(root, package_root)

        # Prefer language from source extension when generic mashup
        if source_relative_path:
            low = source_relative_path.lower().replace("\\", "/")
            if low.endswith(".cs"):
                info.language = "C#"
                if info.framework in ("jest", "vitest", "mocha", "custom"):
                    info.framework = "xunit"
                    info.file_extension = "Tests.cs"
                    info.run_command = ["dotnet", "test"]
                    info.coverage_command = [
                        "dotnet",
                        "test",
                        "--logger:trx",
                        "--collect:XPlat Code Coverage",
                    ]
                    info.compile_command = ["dotnet", "build"]
            elif low.endswith((".ts", ".tsx")):
                info.language = "TypeScript"
            elif low.endswith((".js", ".jsx")):
                info.language = "JavaScript"
            elif low.endswith(".py"):
                info.language = "Python"
                if info.framework == "custom":
                    info.framework = "pytest"
            elif low.endswith(".go"):
                info.language = "Go"
            elif low.endswith(".java"):
                info.language = "Java"
            elif low.endswith(".rs"):
                info.language = "Rust"
            elif low.endswith(".php"):
                info.language = "PHP"

            file_name = file_name_from_source(
                source_relative_path,
                language=info.language,
                kind="unit",
            )
            suggested = under_generated_test_folder(
                "unit",
                file_name,
                source_file_name=source_relative_path,
                module=module or None,
                package_prefix=package_prefix,
            )
            info.suggested_file_name = file_name
            info.suggested_unit_path = suggested

        # Step 5 — overlay monorepo-targeted commands
        info = _apply_monorepo_commands(info, root, source_relative_path)

        return info


def apply_stack_to_generate_fields(
    *,
    language: str,
    framework: str,
    testing_framework: str,
    stack: StackInspect | None,
) -> tuple[str, str, str]:
    """
    Fill language/framework when caller left them empty or 'auto'.
    Does not override an explicit user/framework choice.
    """
    if stack is None:
        return language, framework, testing_framework

    lang = (language or "").strip()
    fw = (framework or "").strip()
    tfw = (testing_framework or "").strip()

    if not lang or lang.lower() in ("auto", "default") or "+" in lang:
        lang = stack.language

    if not fw or fw.lower() in ("auto", "default"):
        fw = stack.framework
    if not tfw or tfw.lower() in ("auto", "default"):
        tfw = stack.framework

    return lang, fw, tfw
