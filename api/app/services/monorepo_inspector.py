"""
Step 5 — Monorepo package isolation & targeted test commands.

Detect workspace kind at repo root, walk to nearest sub-package from a source
path, and build scoped compile / test / coverage commands (pnpm, turbo, nx,
maven, gradle, dotnet, go, python).
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


_NODE_MARKERS = ("package.json",)
_JAVA_MARKERS = ("pom.xml", "build.gradle", "build.gradle.kts")
_PY_MARKERS = ("pyproject.toml", "pytest.ini", "setup.py", "requirements.txt")
_GO_MARKERS = ("go.mod",)
_RUST_MARKERS = ("Cargo.toml",)
_PHP_MARKERS = ("composer.json",)


@dataclass
class MonorepoResolve:
    is_monorepo: bool
    workspace_kind: str
    """pnpm|turbo|nx|lerna|yarn|npm|maven|gradle|dotnet|go|python|none"""
    package_name: str
    """npm scope name, gradle project, folder name, …"""
    package_root: str
    """Relative to project root; empty = repo root."""
    test_command: list[str] = field(default_factory=list)
    coverage_command: list[str] = field(default_factory=list)
    compile_command: list[str] = field(default_factory=list)
    framework_hint: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _rel(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def detect_workspace_kind(project_root: str | Path) -> str:
    root = Path(project_root)
    if (root / "pnpm-workspace.yaml").is_file():
        return "pnpm"
    if (root / "nx.json").is_file():
        return "nx"
    if (root / "turbo.json").is_file():
        return "turbo"
    if (root / "lerna.json").is_file():
        return "lerna"
    if (root / "go.work").is_file():
        return "go"
    # Yarn / npm workspaces via package.json
    root_pkg = _read_json(root / "package.json")
    ws = root_pkg.get("workspaces")
    if ws:
        return "yarn" if (root / "yarn.lock").is_file() else "npm"
    # Maven multi-module
    pom = root / "pom.xml"
    if pom.is_file():
        try:
            text = pom.read_text(encoding="utf-8", errors="replace")
            if "<modules>" in text or "<module>" in text:
                return "maven"
        except Exception:
            pass
    # Gradle multi-project
    for name in ("settings.gradle", "settings.gradle.kts"):
        settings = root / name
        if settings.is_file():
            try:
                text = settings.read_text(encoding="utf-8", errors="replace")
                if "include" in text:
                    return "gradle"
            except Exception:
                pass
    # .NET solution
    if list(root.glob("*.sln")) or list(root.glob("*/*.sln")):
        return "dotnet"
    # Python multi-package (nested pyproject under packages/)
    if (root / "packages").is_dir() and (
        (root / "pyproject.toml").is_file() or (root / "uv.toml").is_file()
    ):
        return "python"
    return "none"


def _has_any(dir_path: Path, names: tuple[str, ...]) -> bool:
    return any((dir_path / n).is_file() for n in names)


def find_package_root(project_root: Path, source_relative: str | None) -> Path:
    """Walk up from source to nearest package/module manifest."""
    if not source_relative or not source_relative.strip():
        return project_root
    full = (project_root / source_relative.replace("\\", "/")).resolve()
    current = full.parent if full.suffix or full.is_file() else full
    if full.is_dir() and not full.suffix:
        current = full
    root_res = project_root.resolve()
    while True:
        try:
            current.relative_to(root_res)
        except ValueError:
            break
        if (
            _has_any(current, _NODE_MARKERS)
            or _has_any(current, _JAVA_MARKERS)
            or _has_any(current, _PY_MARKERS)
            or _has_any(current, _GO_MARKERS)
            or _has_any(current, _RUST_MARKERS)
            or _has_any(current, _PHP_MARKERS)
            or list(current.glob("*.csproj"))
        ):
            # Prefer nested package over repo-root workspace package.json alone
            if current == root_res:
                return current
            return current
        if current == root_res or current.parent == current:
            break
        current = current.parent
    return project_root


def _npm_package_name(package_root: Path) -> str:
    pkg = _read_json(package_root / "package.json")
    return str(pkg.get("name") or package_root.name)


def _node_framework(package_root: Path) -> str:
    pkg = _read_json(package_root / "package.json")
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    if "vitest" in deps:
        return "vitest"
    if "mocha" in deps:
        return "mocha"
    return "jest"


def _mvn_bin(root: Path) -> str:
    return "./mvnw" if (root / "mvnw").is_file() else "mvn"


def _gradle_bin(root: Path) -> str:
    if (root / "gradlew").is_file():
        return "./gradlew"
    if (root / "gradlew.bat").is_file():
        return "gradlew.bat"
    return "gradle"


def _gradle_project_path(package_root_rel: str) -> str:
    """services/auth-service → :services:auth-service"""
    parts = [p for p in package_root_rel.replace("\\", "/").split("/") if p]
    if not parts:
        return ""
    return ":" + ":".join(parts)


def _dotnet_test_target(root: Path, package_root: Path) -> str:
    """Prefer a *.Tests.csproj near package; else package csproj; else empty (dotnet test)."""
    # Sibling / nested test projects
    candidates: list[Path] = []
    for pattern in (
        "*Tests*.csproj",
        "*.Tests.csproj",
        "tests/*/*.csproj",
        "../tests/*/*.csproj",
    ):
        candidates.extend(sorted(package_root.glob(pattern)))
    parent = package_root.parent
    if parent.is_dir():
        tests_dir = parent / "tests"
        if tests_dir.is_dir():
            candidates.extend(sorted(tests_dir.glob("*/*.csproj")))
            candidates.extend(sorted(tests_dir.glob("*.csproj")))
    for c in candidates:
        if c.is_file():
            return _rel(root, c)
    for c in sorted(package_root.glob("*.csproj")):
        return _rel(root, c)
    return ""


def build_targeted_commands(
    *,
    root: Path,
    package_root: Path,
    workspace_kind: str,
    package_name: str,
    package_root_rel: str,
) -> tuple[list[str], list[str], list[str], str]:
    """
    Returns (test_command, coverage_command, compile_command, framework_hint).

    Workspace filters (-w / --filter / yarn workspace) ONLY when root truly has
    that tooling. Nested folders without workspaces get package-local ``npm test``
    (Desktop resolve_test_cwd cds into the package).
    """
    kind = workspace_kind
    is_nested = package_root.resolve() != root.resolve() and bool(package_root_rel)
    real_node_workspace = kind in ("pnpm", "turbo", "nx", "lerna", "yarn", "npm")

    # --- Node family ---
    if (package_root / "package.json").is_file() or real_node_workspace:
        fw = _node_framework(package_root) if (package_root / "package.json").is_file() else "jest"
        name = package_name or package_root.name
        if is_nested and kind == "pnpm":
            test = ["pnpm", "--filter", name, "test"]
            cov = ["pnpm", "--filter", name, "test", "--", "--coverage"]
            return test, cov, [], fw
        if is_nested and kind == "turbo":
            filt = f"--filter={name}"
            return (
                ["npx", "turbo", "run", "test", filt],
                ["npx", "turbo", "run", "test", filt, "--", "--coverage"],
                [],
                fw,
            )
        if is_nested and kind == "nx":
            # Nx project name often equals folder or package name without scope
            nx_name = name.split("/")[-1] if name.startswith("@") else name
            return (
                ["npx", "nx", "test", nx_name],
                ["npx", "nx", "test", nx_name, "--coverage"],
                [],
                fw,
            )
        if is_nested and kind in ("lerna", "yarn", "npm"):
            # Only when detect_workspace_kind found real workspaces / lerna
            if kind == "yarn":
                test = ["yarn", "workspace", name, "test"]
                cov = ["yarn", "workspace", name, "test", "--coverage"]
            elif kind == "lerna":
                test = ["npx", "lerna", "run", "test", f"--scope={name}"]
                cov = ["npx", "lerna", "run", "test", f"--scope={name}", "--", "--coverage"]
            else:
                # npm workspaces (package.json workspaces field at root)
                test = ["npm", "run", "test", "-w", name]
                cov = ["npm", "run", "test", "-w", name, "--", "--coverage"]
            return test, cov, [], fw
        # Single package, or nested folder without npm/yarn workspaces:
        # run locally in package (cwd = package_root).
        if fw == "vitest":
            return (
                ["npx", "vitest", "run"],
                ["npx", "vitest", "run", "--coverage"],
                [],
                fw,
            )
        return (
            ["npx", "jest", "--config", "AItest/jest.config.cjs", "--runInBand", "--passWithNoTests"],
            ["npx", "jest", "--config", "AItest/jest.config.cjs", "--coverage"],
            [],
            fw,
        )

    # --- Maven ---
    if (package_root / "pom.xml").is_file() or kind == "maven":
        mvn = _mvn_bin(root if (root / "mvnw").is_file() else package_root)
        if is_nested and package_root_rel:
            test = [mvn, "test", "-pl", package_root_rel, "-am"]
            compile_cmd = [mvn, "-q", "-DskipTests", "compile", "-pl", package_root_rel, "-am"]
        else:
            test = [mvn, "test"]
            compile_cmd = [mvn, "-q", "-DskipTests", "compile"]
        return test, list(test), compile_cmd, "junit5"

    # --- Gradle ---
    if (
        (package_root / "build.gradle").is_file()
        or (package_root / "build.gradle.kts").is_file()
        or kind == "gradle"
    ):
        gw = _gradle_bin(root if (root / "gradlew").is_file() or (root / "gradlew.bat").is_file() else package_root)
        gpath = _gradle_project_path(package_root_rel) if is_nested else ""
        if gpath:
            test = [gw, f"{gpath}:test"]
            compile_cmd = [gw, f"{gpath}:compileJava"]
        else:
            test = [gw, "test"]
            compile_cmd = [gw, "compileJava"]
        return test, list(test), compile_cmd, "junit5"

    # --- .NET ---
    if list(package_root.glob("*.csproj")) or kind == "dotnet" or list(root.glob("*.sln")):
        target = _dotnet_test_target(root, package_root)
        base = ["dotnet", "test"]
        if target:
            base = ["dotnet", "test", target]
        cov = [
            *base,
            "--logger:trx",
            '--collect:XPlat Code Coverage',
        ]
        compile_cmd = ["dotnet", "build", target] if target else ["dotnet", "build"]
        return base, cov, compile_cmd, "xunit"

    # --- Go ---
    if (package_root / "go.mod").is_file() or kind == "go":
        scope = f"./{package_root_rel}/..." if is_nested and package_root_rel else "./..."
        test = ["go", "test", "-v", scope]
        cov = ["go", "test", "-v", "-coverprofile=coverage.out", scope]
        return test, cov, [], "testing"

    # --- Python ---
    if (
        _has_any(package_root, _PY_MARKERS)
        or kind == "python"
    ):
        if is_nested and package_root_rel:
            # Prefer package-local tests dir when present
            tests_rel = f"{package_root_rel}/tests"
            if (package_root / "tests").is_dir():
                target = tests_rel
            else:
                target = package_root_rel
            test = ["pytest", target]
            cov = [
                "pytest",
                target,
                "--cov",
                package_root_rel,
                f"--cov-report=xml:{package_root_rel}/coverage.xml",
                f"--junitxml={package_root_rel}/report.xml",
            ]
        else:
            test = ["pytest"]
            cov = [
                "pytest",
                "--cov=.",
                "--cov-report=xml:coverage.xml",
                "--junitxml=report.xml",
            ]
        return test, cov, [], "pytest"

    # --- Rust ---
    if (package_root / "Cargo.toml").is_file():
        return ["cargo", "test"], ["cargo", "test"], [], "cargo"

    # --- PHP ---
    if (package_root / "composer.json").is_file():
        phpunit = (
            str(Path(package_root_rel) / "vendor" / "bin" / "phpunit")
            if is_nested and package_root_rel
            else "./vendor/bin/phpunit"
        )
        test = [phpunit]
        cov = [phpunit, "--coverage-clover", "coverage.xml"]
        return test, cov, [], "phpunit"

    return [], [], [], ""


class MonorepoInspector:
    """Resolve sub-package + targeted sandbox commands for a source file."""

    @staticmethod
    def resolve(
        project_root: str,
        source_relative_path: str | None = None,
    ) -> MonorepoResolve:
        root = Path(project_root)
        if not root.is_dir():
            raise ValueError(f"projectRoot không tồn tại: {project_root}")

        kind = detect_workspace_kind(root)
        package_root = find_package_root(root, source_relative_path)
        package_root_rel = _rel(root, package_root) if package_root.resolve() != root.resolve() else ""

        # Package display name
        if (package_root / "package.json").is_file():
            package_name = _npm_package_name(package_root)
        else:
            package_name = package_root.name if package_root_rel else "root"

        is_monorepo = bool(package_root_rel) and kind != "none"
        # Nested package under a repo WITHOUT real workspace tooling (e.g. TestIDE/backend
        # with its own package.json). Isolate via package-local commands — NEVER invent
        # ``npm -w`` / yarn workspace filters (that needs package.json#workspaces).
        if package_root_rel and kind == "none":
            is_monorepo = True
            if (package_root / "package.json").is_file():
                kind = "node"  # local package cwd; build_targeted_commands → npm test
            elif (package_root / "pom.xml").is_file() and (root / "pom.xml").is_file():
                kind = "maven"
            elif _has_any(package_root, _PY_MARKERS):
                kind = "python"
            elif (package_root / "go.mod").is_file():
                kind = "go"
            elif list(package_root.glob("*.csproj")):
                kind = "dotnet"
            elif _has_any(package_root, _JAVA_MARKERS):
                kind = "maven" if (package_root / "pom.xml").is_file() else "gradle"

        test_cmd, cov_cmd, compile_cmd, fw = build_targeted_commands(
            root=root,
            package_root=package_root,
            workspace_kind=kind if is_monorepo or kind != "none" else kind,
            package_name=package_name,
            package_root_rel=package_root_rel,
        )

        # When not nested, still return stack-local commands
        if not test_cmd:
            test_cmd, cov_cmd, compile_cmd, fw = build_targeted_commands(
                root=root,
                package_root=package_root,
                workspace_kind=kind,
                package_name=package_name,
                package_root_rel=package_root_rel,
            )

        return MonorepoResolve(
            is_monorepo=is_monorepo,
            workspace_kind=kind if is_monorepo or kind != "none" else "none",
            package_name=package_name,
            package_root=package_root_rel,
            test_command=test_cmd,
            coverage_command=cov_cmd,
            compile_command=compile_cmd,
            framework_hint=fw,
        )


def shell_join(cmd: list[str]) -> str:
    """Join argv for Desktop Input / shell (quote tokens with spaces)."""
    parts: list[str] = []
    for c in cmd:
        if re.search(r"\s", c) and not (c.startswith('"') and c.endswith('"')):
            parts.append(f'"{c}"')
        else:
            parts.append(c)
    return " ".join(parts)
