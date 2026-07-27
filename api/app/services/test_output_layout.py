"""
Output layout for generated tests applied into the user's repo.

[{pkg}/]AItest/                 ← always sibling of the package that owns src/lib
  UnitTest/ | IntegrationTest/ | APITest/ | E2ETest/
    {Module}/
      {TestFile}

Monorepo (e.g. root with backend/ + frontend/):
  backend/src/…  → backend/AItest/…
  frontend/src/… → frontend/AItest/…
Never place AItest at monorepo root for nested package sources.

Single-package repo (Apply root == package):
  src/… → AItest/…

Desktop also stages under [{pkg}/].ai-test/ (not monorepo-root .ai-test).
"""

from __future__ import annotations

import os
import re

# Root folder at project path (Apply target)
AITEST_ROOT = "AItest"

GENERATED_TEST_FOLDERS: dict[str, str] = {
    "unit": "UnitTest",
    "integration": "IntegrationTest",
    "api": "APITest",
    "e2e": "E2ETest",
}

_KIND_ALIASES = {
    "apitest": "api",
    "api-test": "api",
    "unittest": "unit",
    "unit-test": "unit",
    "integrationtest": "integration",
    "e2etest": "e2e",
    "endtoend": "e2e",
}

# Leading / mid segments that are tooling or SPA shells — never keep under AItest
_TECH_SEGMENTS = frozenset(
    {
        "src",
        "app",
        "lib",
        "libs",
        "source",
        "sources",
        "backend",
        "frontend",
        "server",
        "client",
        "clientapp",
        "serverapp",
        "webapp",
        "web",
        "wwwroot",
        "public",
        "packages",
        "pkg",
        "internal",
        "cmd",
        "dist",
        "build",
        "bin",
        "obj",
        "node_modules",
        "vendor",
        "third_party",
        "thirdparty",
        "__pycache__",
        "target",
        "out",
        "assets",
        "environments",
        "shared",
        "core",
        "common",
        "components",  # Angular noise when alone as folder chain
    }
)

_STRIP_PREFIX_TREES = (
    "aitest/",
    "unittest/",
    "integrationtest/",
    "apitest/",
    "e2etest/",
    "tests/",
    "test/",
    "__tests__/",
    "spec/",
    "specs/",
    "src/test/java/",
    "src/test/kotlin/",
)

_MAX_MODULE_DEPTH = 2


def normalize_kind(kind: str | None) -> str:
    k = (kind or "unit").strip().lower().replace(" ", "")
    k = _KIND_ALIASES.get(k, k)
    if k not in GENERATED_TEST_FOLDERS:
        return "unit"
    return k


def generated_test_root(kind: str = "unit") -> str:
    return GENERATED_TEST_FOLDERS[normalize_kind(kind)]


def aitest_kind_root(kind: str = "unit") -> str:
    return f"{AITEST_ROOT}/{generated_test_root(kind)}"


def reports_dir() -> str:
    return f"{AITEST_ROOT}/Reports"


def coverage_dir() -> str:
    return f"{AITEST_ROOT}/Coverage"


def metadata_dir() -> str:
    return f"{AITEST_ROOT}/Metadata"


def metadata_path(run_id: str, file_name: str | None = None) -> str:
    name = file_name or f"{run_id}.json"
    return f"{metadata_dir()}/{name}".replace("//", "/")


def _norm_rel(path: str | None) -> str:
    p = (path or "").replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    return p.strip("/")


def sanitize_module_label(module: str | None) -> str:
    """TC.module → safe single/short folder (no path traversal)."""
    mod = (module or "").replace("\\", "/").strip().strip("/")
    mod = re.sub(r'[<>:"|?*]', "", mod)
    parts = [p for p in mod.split("/") if p and p not in (".", "..")]
    # Keep at most 2 segments from TC label
    parts = parts[:_MAX_MODULE_DEPTH]
    return "/".join(parts)


def module_rel_from_source(source_rel: str | None) -> str:
    """
    Short business module from source path — strip SPA/tech shells, cap depth.
    Example:
      Forensic/ClientApp/src/app/admin/case-record/update/foo.ts
      → Forensic/case-record   (or case-record/update)
    """
    p = _norm_rel(source_rel)
    if not p:
        return ""

    if "." in os.path.basename(p) and not p.endswith("/"):
        p = os.path.dirname(p).replace("\\", "/")

    p = p.strip("/")
    low = p.lower()

    for prefix in _STRIP_PREFIX_TREES:
        if low.startswith(prefix):
            p = p[len(prefix) :]
            low = p.lower()
            break

    parts = [seg for seg in p.split("/") if seg and seg not in (".", "..")]

    # Drop tech/SPA shells anywhere they appear (not only leading)
    parts = [seg for seg in parts if seg.lower() not in _TECH_SEGMENTS]

    if parts and parts[0].lower() == AITEST_ROOT.lower():
        parts = parts[1:]
        if parts and parts[0].lower() in {v.lower() for v in GENERATED_TEST_FOLDERS.values()}:
            parts = parts[1:]

    if not parts:
        return ""

    # Prefer: first business root + last feature folder (skip deep admin/…)
    if len(parts) <= _MAX_MODULE_DEPTH:
        return "/".join(parts)
    # Forensic/.../case-record/update → Forensic/update (root + leaf)
    return f"{parts[0]}/{parts[-1]}"


def file_name_from_source(
    source_file_name: str,
    *,
    language: str = "",
    class_name: str = "",
    kind: str = "unit",
) -> str:
    src = _norm_rel(source_file_name)
    stem = os.path.splitext(os.path.basename(src) or "")[0]
    base = re.sub(r"[^a-zA-Z0-9_]", "", class_name or stem or "Target") or "Target"
    lang = (language or "").lower()
    ext = os.path.splitext(src)[1].lower() if src else ""
    k = normalize_kind(kind)

    if "python" in lang or ext == ".py":
        name = stem or base.lower()
        if not name.lower().startswith("test_"):
            name = f"test_{name.lower()}"
        return f"{name}.py" if not name.endswith(".py") else name

    if "go" in lang or ext == ".go":
        stem_g = stem or base
        if k == "api":
            return f"{stem_g.lower()}_api_test.go"
        return f"{stem_g}_test.go"

    if "typescript" in lang or "javascript" in lang or ext in (".ts", ".tsx", ".js", ".jsx"):
        use_ext = ext if ext in (".ts", ".tsx", ".js", ".jsx") else (".ts" if "typescript" in lang else ".js")
        stem_js = stem or base
        if k == "api":
            return f"{stem_js}.api.test{use_ext}"
        return f"{stem_js}.test{use_ext}"

    if "java" in lang or ext == ".java":
        return f"{base}Test.java" if not base.endswith("Test") else f"{base}.java"

    if "kotlin" in lang or ext == ".kt":
        return f"{base}Test.kt" if not base.endswith("Test") else f"{base}.kt"

    if "c#" in lang or "csharp" in lang or ext == ".cs":
        if k == "api":
            return f"{base}ApiTests.cs" if "ApiTests" not in base else f"{base}.cs"
        return f"{base}Tests.cs" if not base.endswith("Tests") else f"{base}.cs"

    if "rust" in lang or ext == ".rs":
        return f"{base.lower()}_test.rs"

    return f"{base}Tests{ext or '.txt'}"


# Structural code-root folders — AItest is placed as a sibling of these.
_CODE_ROOT_MARKERS = frozenset({"src", "lib", "libs"})


def package_prefix_from_source(
    source_rel: str | None,
    *,
    package_prefix: str | None = None,
) -> str:
    """
    Directory that owns the source package — place AItest next to its src/lib.

    Generic (any project name):
      {any}/src/… → {any}
      apps/web/src/x.ts → apps/web
      product/WebSpa/src/app/x.ts → product/WebSpa
      src/todos/x.ts → "" (code root is already at apply root)

    Optional ``package_prefix`` overrides path heuristic (from Desktop FS discovery).
    Pass ``package_prefix=""`` to force repo-root AItest/.
    """
    if package_prefix is not None:
        return _norm_rel(package_prefix)

    p = _norm_rel(source_rel)
    if not p:
        return ""
    parts = [seg for seg in p.split("/") if seg and seg not in (".", "..")]
    if len(parts) < 2:
        return ""
    for i, seg in enumerate(parts[:-1]):
        if seg.lower() not in _CODE_ROOT_MARKERS:
            continue
        if i == 0:
            return ""
        prefix_parts = parts[:i]
        low_join = "/".join(s.lower() for s in prefix_parts)
        if low_join == AITEST_ROOT.lower() or "/aitest/" in f"/{low_join}/":
            return ""
        return "/".join(prefix_parts)
    return ""


def relative_module_specifier(from_file: str, to_file: str) -> str:
    """Relative import from generated test → source (TS/JS, no extension)."""
    frm = _norm_rel(from_file)
    to = _norm_rel(to_file)
    if not frm or not to:
        return ""
    from_dir = os.path.dirname(frm).replace("\\", "/") or "."
    to_no_ext = re.sub(r"\.(tsx?|jsx?)$", "", to, flags=re.IGNORECASE)
    rel = os.path.relpath(to_no_ext, from_dir).replace("\\", "/")
    if not rel.startswith("."):
        rel = f"./{rel}"
    return rel


def sut_module_specifier(test_rel: str, source_rel: str) -> str:
    """
    Prefer package-root `src/…` imports (Nest baseUrl) so depth under AItest
    does not break resolution. Fall back to relative path.
    """
    to = _norm_rel(source_rel)
    if not to:
        return ""
    parts = [p for p in to.split("/") if p]
    for i, seg in enumerate(parts):
        if seg.lower() == "src":
            rest = "/".join(parts[i:])
            return re.sub(r"\.(tsx?|jsx?)$", "", rest, flags=re.IGNORECASE)
    return relative_module_specifier(test_rel, source_rel)


def rewrite_sut_imports(code: str, *, test_rel: str, source_rel: str) -> str:
    """Rewrite SUT imports and secondary relative imports to stable specifiers that resolve from AItest."""
    if not code or not test_rel or not source_rel:
        return code
    correct = sut_module_specifier(test_rel, source_rel)
    if not correct:
        return code
    src_base = os.path.splitext(os.path.basename(source_rel.replace("\\", "/")))[0]
    if not src_base:
        return code

    source_dir = os.path.dirname(_norm_rel(source_rel)) or "."

    def strip_ext(p: str) -> str:
        return re.sub(r"\.(tsx?|jsx?)$", "", p, flags=re.IGNORECASE)

    def as_src_specifier(spec: str) -> str | None:
        n = strip_ext(spec.replace("\\", "/"))
        if n.startswith("src/"):
            return n
        idx = n.lower().find("/src/")
        if idx >= 0:
            return n[idx + 1 :]
        return None

    def is_bare_npm(spec: str) -> bool:
        if spec.startswith(".") or spec.startswith("/") or spec.startswith("src/"):
            return False
        if spec.startswith("@/"):
            return False
        if spec.startswith("@") and "/" in spec:
            return src_base.lower() not in spec.lower()
        if "/" not in spec and not spec.startswith("@"):
            return True
        return False

    pattern = re.compile(
        r"""((?:from|require\s*\()\s*['"])([^'"]+)(['"])""",
        re.MULTILINE,
    )

    def repl(m: re.Match[str]) -> str:
        prefix, spec, suffix = m.group(1), m.group(2), m.group(3)
        spec_norm = spec.replace("\\", "/")
        if is_bare_npm(spec_norm):
            return m.group(0)

        if spec_norm.startswith("@/"):
            return f"{prefix}src/{strip_ext(spec_norm[2:])}{suffix}"
        if spec_norm.startswith("~/"):
            return f"{prefix}src/{strip_ext(spec_norm[2:])}{suffix}"

        from_src = as_src_specifier(spec_norm)
        if from_src:
            if (
                from_src.lower() == correct.lower()
                or from_src.lower().endswith(f"/{src_base.lower()}")
                or from_src.lower() == src_base.lower()
            ):
                return f"{prefix}{correct}{suffix}"
            return f"{prefix}{from_src}{suffix}"

        spec_base = os.path.splitext(os.path.basename(spec_norm))[0]
        if (
            spec_base.lower() == src_base.lower()
            or src_base.lower() in spec_norm.lower()
        ):
            if (
                spec_norm.startswith("@")
                and not spec_norm.startswith("@/")
                and spec_base.lower() != src_base.lower()
            ):
                return m.group(0)
            return f"{prefix}{correct}{suffix}"

        # Relatives: AI usually writes them relative to the SUT file
        if spec_norm.startswith("."):
            resolved = os.path.normpath(os.path.join(source_dir, spec_norm)).replace(
                "\\", "/"
            )
            src_spec = as_src_specifier(resolved)
            if not src_spec and resolved.lower().startswith("src/"):
                src_spec = strip_ext(resolved)
            if src_spec:
                leaf = os.path.splitext(os.path.basename(src_spec))[0]
                if (
                    src_spec.lower() == correct.lower()
                    or leaf.lower() == src_base.lower()
                ):
                    return f"{prefix}{correct}{suffix}"
                return f"{prefix}{src_spec}{suffix}"
            rel = relative_module_specifier(test_rel, resolved)
            if rel:
                return f"{prefix}{strip_ext(rel)}{suffix}"

        return m.group(0)

    out = pattern.sub(repl, code)

    # Python: fix deep relative imports that point at the SUT module
    src_norm = source_rel.replace("\\", "/").lower()
    if src_norm.endswith(".py") and src_base:
        py_mod = re.sub(r"\.py$", "", _norm_rel(source_rel).replace("/", "."))
        for prefix in ("src.", "app.", "lib."):
            if py_mod.startswith(prefix):
                py_mod = py_mod[len(prefix) :]
                break
        if py_mod:
            out = re.sub(
                rf"from\s+\.+[\w.]*{re.escape(src_base)}\s+import\s+",
                f"from {py_mod} import ",
                out,
                flags=re.IGNORECASE,
            )

    return out


def under_generated_test_folder(
    kind: str,
    file_name: str,
    source_dir: str | None = None,
    *,
    source_file_name: str | None = None,
    module: str | None = None,
    package_prefix: str | None = None,
) -> str:
    """
    Final relative path: [{pkg}/]AItest/{Kind}/{Module}/file

    Prefer Approved TC ``module`` (flat). Else short path from source.
    ``package_prefix`` (optional) overrides heuristic — use FS-discovered package root.
    """
    kind_root = aitest_kind_root(kind)
    src_key = source_file_name or source_dir
    used_tc_module = bool(sanitize_module_label(module))
    pkg = package_prefix_from_source(src_key, package_prefix=package_prefix)
    if pkg:
        kind_root = f"{pkg}/{kind_root}"
    name = (file_name or "Tests.txt").replace("\\", "/").lstrip("/")

    mod = sanitize_module_label(module)
    if not mod:
        mod = module_rel_from_source(src_key)

    if mod.lower().startswith(AITEST_ROOT.lower() + "/"):
        mod = module_rel_from_source(mod)

    if mod:
        kind_name = generated_test_root(kind).lower()
        parts = [p for p in mod.split("/") if p]
        if parts and parts[0].lower() == kind_name:
            parts = parts[1:]
        parts = [p for p in parts if p.lower() not in _TECH_SEGMENTS]
        # Only strip package segments from source-derived modules (keep TC labels).
        if pkg and not used_tc_module:
            pkg_parts = pkg.lower().split("/")
            while parts and pkg_parts and parts[0].lower() == pkg_parts[0]:
                parts = parts[1:]
                pkg_parts = pkg_parts[1:]
        mod = "/".join(parts[:_MAX_MODULE_DEPTH])

    if mod:
        return f"{kind_root}/{mod}/{name}".replace("//", "/")
    return f"{kind_root}/{name}".replace("//", "/")


def assert_safe_aitest_target_rel(target_rel: str) -> str:
    """P5 path jail — Apply under AItest/ or {anyPkg}/AItest/; no production mirror under AItest."""
    p = (target_rel or "").replace("\\", "/").strip().lstrip("/")
    if not p:
        raise ValueError("Path jail: empty target")
    parts = p.split("/")
    if ".." in parts or (len(p) >= 2 and p[1] == ":"):
        raise ValueError("Path jail: '..' or absolute drive not allowed")
    low_parts = [s.lower() for s in parts]
    try:
        ait_idx = low_parts.index(AITEST_ROOT.lower())
    except ValueError as exc:
        raise ValueError(f"Path jail: must be under {AITEST_ROOT}/ (got {p})") from exc
    after = low_parts[ait_idx + 1 :]
    if not after:
        raise ValueError(f"Path jail: incomplete path under {AITEST_ROOT}/")
    forbidden_under_aitest = frozenset(
        {
            "src",
            "app",
            "lib",
            "libs",
            "clientapp",
            "serverapp",
            "webapp",
            "wwwroot",
            "node_modules",
            "dist",
            "build",
            "bin",
            "obj",
        }
    )
    if any(seg in forbidden_under_aitest for seg in after):
        raise ValueError(
            "Path jail: do not mirror production folders under AItest "
            f"(got {p})"
        )
    return p
