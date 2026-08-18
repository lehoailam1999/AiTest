"""
Output layout for generated tests applied into the user's repo.

[{pkg}/]AItest/                 ← always sibling of the package that owns src/lib
  UnitTest/ | IntegrationTest/ | APITest/ | E2ETest/
    E2ETest/_shared/            ← auth.helper, storage, shim, shared POM pages
    E2ETest/{Requirement}/{TC}/ ← specs/ + playwright.config.ts only
    {other kinds}/{Module}/…

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
import unicodedata

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

# Structural build/tooling folders — strip from module path on EVERY project.
# Do NOT put package-role names here (backend/frontend/web/client/shared/…) —
# those are often real business folders in other repos.
_STRUCTURAL_SEGMENTS = frozenset(
    {
        "src",
        "lib",
        "libs",
        "source",
        "sources",
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
        "wwwroot",
        "public",
        "assets",
        "environments",
    }
)

# SPA / host shells — strip from module labels only (package_prefix still keeps them).
# Extensible via AITEST_SPA_SHELLS=webspa,myshell (comma-separated, case-insensitive).
_DEFAULT_SPA_SHELLS = frozenset(
    {
        "clientapp",
        "serverapp",
        "webapp",
        "webspa",
        "spa",
    }
)


def _env_segment_set(var_name: str, defaults: frozenset[str]) -> frozenset[str]:
    raw = (os.environ.get(var_name) or "").strip()
    if not raw:
        return defaults
    extra = {s.strip().lower() for s in raw.split(",") if s.strip()}
    return frozenset(defaults | extra)


def _structural_segments() -> frozenset[str]:
    return _env_segment_set("AITEST_STRUCTURAL_SEGMENTS", _STRUCTURAL_SEGMENTS)


def _spa_shell_segments() -> frozenset[str]:
    return _env_segment_set("AITEST_SPA_SHELLS", _DEFAULT_SPA_SHELLS)


# Back-compat alias used by older call sites / tests
def _tech_segments() -> frozenset[str]:
    return _structural_segments() | _spa_shell_segments()


_TECH_SEGMENTS = _STRUCTURAL_SEGMENTS | _DEFAULT_SPA_SHELLS  # static snapshot for imports

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
    """TC.module → ASCII-safe short folder (no path traversal)."""
    mod = (module or "").replace("\\", "/").strip().strip("/")
    parts: list[str] = []
    for p in mod.split("/"):
        if not p or p in (".", ".."):
            continue
        seg = sanitize_path_segment(p)
        if seg and seg not in (".", ".."):
            parts.append(seg)
    return "/".join(parts[:_MAX_MODULE_DEPTH])


# Windows MAX_PATH is 260; keep each title folder short so
# {root}/AItest/E2ETest/{req}/{tc}/specs/{file}.spec.ts stays safe on any OS.
_MAX_PATH_SEGMENT_LEN = 40

# Keep Playwright/test + POM compound suffixes when truncating long filenames.
_COMPOUND_FILE_EXTS = (
    ".spec.ts",
    ".spec.tsx",
    ".test.ts",
    ".test.tsx",
    ".page.ts",
    ".page.tsx",
    ".setup.ts",
    ".helper.ts",
    ".d.ts",
)


def _stable_seg_hash(s: str) -> str:
    """FNV-1a 32-bit → 8 hex (matches desktop testOutputLayout; no crypto dep)."""
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def truncate_path_segment(seg: str, *, max_len: int = _MAX_PATH_SEGMENT_LEN) -> str:
    """Stable shorten: readable prefix + 8-char hash (deterministic across runs)."""
    s = (seg or "").strip()
    if not s or len(s) <= max_len:
        return s
    digest = _stable_seg_hash(s)
    keep = max(8, max_len - 9)
    prefix = s[:keep].rstrip("-._ ")
    return f"{prefix}-{digest}"


def split_e2e_filename(name: str) -> tuple[str, str]:
    """Split ``foo.bar.spec.ts`` → (``foo.bar``, ``.spec.ts``); preserve POM/test suffixes."""
    n = name or ""
    low = n.lower()
    for ext in _COMPOUND_FILE_EXTS:
        if low.endswith(ext):
            return n[: -len(ext)], n[-len(ext) :]
    if "." in n:
        stem, _, ext = n.rpartition(".")
        return stem, f".{ext}"
    return n, ""


def _strip_diacritics(s: str) -> str:
    s = (s or "").replace("đ", "d").replace("Đ", "D")
    nfd = unicodedata.normalize("NFD", s)
    return "".join(c for c in nfd if unicodedata.category(c) != "Mn")


def sanitize_path_segment(raw: str | None, *, max_len: int = _MAX_PATH_SEGMENT_LEN) -> str:
    """
    Safe single folder segment for title-like labels.
    - ASCII slug (strip diacritics, lowercase)
    - never creates nested dirs from `/` or `\\`
    - strips shell/glob-sensitive brackets
    - caps length (Windows MAX_PATH; long Vietnamese TC titles)
    """
    s = (raw or "").replace("\\", "/").strip()
    if not s:
        return ""
    s = _strip_diacritics(s)
    s = re.sub(r'[<>:"|?*\[\]]', "", s)
    s = s.replace("/", "-")
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    s = s.lower()
    if s in {".", ".."}:
        return ""
    return truncate_path_segment(s, max_len=max_len)


def shorten_e2e_rel_path(rel: str, *, max_seg: int = _MAX_PATH_SEGMENT_LEN) -> str:
    """
    Shorten oversized path segments under AItest/E2ETest (already-generated long titles).
    Leaves structural names (AItest, E2ETest, pages, specs, fixtures) alone.
    File leaves keep compound suffixes (``.spec.ts``, ``.page.ts``, …).
    """
    p = (rel or "").replace("\\", "/").strip()
    if not p:
        return p
    parts = [x for x in p.split("/") if x]
    structural = {
        "aitest",
        "e2etest",
        "pages",
        "specs",
        "fixtures",
        "helpers",
        "unittest",
        "apitest",
        "integrationtest",
    }
    out: list[str] = []
    for i, part in enumerate(parts):
        is_file = i == len(parts) - 1 and "." in part
        if part.lower() in structural:
            out.append(part)
        elif is_file:
            stem, ext = split_e2e_filename(part)
            # Cap long stems; always re-attach full compound extension.
            if stem and len(part) > max_seg + len(ext):
                out.append(f"{truncate_path_segment(stem, max_len=max_seg)}{ext}")
            else:
                out.append(part)
        else:
            out.append(truncate_path_segment(part, max_len=max_seg))
    return "/".join(out)


def module_rel_from_source(source_rel: str | None) -> str:
    """
    Short business module from source path — strip structural/SPA shells, cap depth.

    Generic for any project name. Examples:
      {pkg}/src/Order/Services/x.cs → Order/Services
      {product}/{SpaShell}/src/app/admin/feature/update/x.ts → feature/update
      internal/order/order.go → internal/order
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
    tech = _tech_segments()
    spa = _spa_shell_segments()

    cleaned: list[str] = []
    for i, seg in enumerate(parts):
        low_seg = seg.lower()
        if low_seg in tech or low_seg in spa:
            continue
        # Angular convention: only strip bare `app` when it sits under `src`
        if low_seg == "app" and i > 0 and parts[i - 1].lower() == "src":
            continue
        cleaned.append(seg)
    parts = cleaned

    if parts and parts[0].lower() == AITEST_ROOT.lower():
        parts = parts[1:]
        if parts and parts[0].lower() in {v.lower() for v in GENERATED_TEST_FOLDERS.values()}:
            parts = parts[1:]

    if not parts:
        return ""

    # Prefer leaf business folders (last N) — works across monorepo depths
    if len(parts) <= _MAX_MODULE_DEPTH:
        return "/".join(parts)
    return "/".join(parts[-_MAX_MODULE_DEPTH:])


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
# Extend via AITEST_CODE_ROOT_MARKERS=src,lib,libs,app
_DEFAULT_CODE_ROOT_MARKERS = frozenset({"src", "lib", "libs"})


def _code_root_markers() -> frozenset[str]:
    return _env_segment_set("AITEST_CODE_ROOT_MARKERS", _DEFAULT_CODE_ROOT_MARKERS)


_CODE_ROOT_MARKERS = _DEFAULT_CODE_ROOT_MARKERS


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
      src/orders/x.ts → "" (code root is already at apply root)

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
    markers = _code_root_markers()
    for i, seg in enumerate(parts[:-1]):
        low = seg.lower()
        if low not in markers:
            continue
        # Django-style: treat `app` as code root only when not under `src`
        if low == "app" and i > 0 and parts[i - 1].lower() == "src":
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
        drop = _tech_segments() | _spa_shell_segments()
        parts = [p for p in parts if p.lower() not in drop]
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


def _build_e2e_module(
    module: str = "",
    requirement_title: str = "",
    test_case_title: str = "",
) -> str:
    """
    Build E2E subfolder — always prefer {Requirement}/{TC}.

    Priority:
      1) requirement_title / test_case_title  → {Requirement}/{TC}
      2) module / test_case_title             → {ModuleAsReq}/{TC}
      3) requirement_title only               → {Requirement}
      4) test_case_title only                 → {TC}
      5) module (last resort)                 → {Module}
    """
    req = sanitize_path_segment(requirement_title)
    tc = sanitize_path_segment(test_case_title)
    mod = sanitize_path_segment(module)
    if req and tc:
        return f"{req}/{tc}"
    if mod and tc:
        return f"{mod}/{tc}"
    if req:
        return req
    if tc:
        return tc
    return mod


def e2e_suite_root(
    *,
    package_prefix: str | None = None,
    source_file_name: str | None = None,
) -> str:
    """[{pkg}/]AItest/E2ETest (no trailing slash) — parent of _shared and {Req}/{TC}."""
    kind_root = aitest_kind_root("e2e")
    pkg = package_prefix_from_source(source_file_name, package_prefix=package_prefix)
    if pkg:
        return f"{pkg}/{kind_root}".replace("//", "/")
    return kind_root


def e2e_shared_root(
    *,
    package_prefix: str | None = None,
    source_file_name: str | None = None,
) -> str:
    """[{pkg}/]AItest/E2ETest/_shared — auth, storage, shim, shared POMs."""
    return f"{e2e_suite_root(package_prefix=package_prefix, source_file_name=source_file_name)}/_shared"


def e2e_module_root(
    module: str = "",
    *,
    package_prefix: str | None = None,
    source_file_name: str | None = None,
    requirement_title: str = "",
    test_case_title: str = "",
) -> str:
    """[{pkg}/]AItest/E2ETest/{Requirement}/{TC} (no trailing slash)."""
    kind_root = e2e_suite_root(
        package_prefix=package_prefix, source_file_name=source_file_name
    )
    mod = _build_e2e_module(module, requirement_title, test_case_title)
    if mod:
        return f"{kind_root}/{mod}".replace("//", "/")
    return kind_root


def _is_e2e_shared_artifact(path: str, kind: str = "") -> bool:
    """True when file belongs under E2ETest/_shared (not per-TC)."""
    p = (path or "").replace("\\", "/").lower()
    base = os.path.basename(p)
    k = (kind or "").lower()
    if k == "page" or p.endswith(".page.ts") or "/pages/" in f"/{p}/":
        return True
    if base in (
        "auth.helper.ts",
        "storagestate.json",
        "global.setup.ts",
        "playwright-shim.d.ts",
    ):
        return True
    if "/types/" in f"/{p}/" and "shim" in base:
        return True
    if k == "fixture" and base.endswith((".json", ".ts")) and (
        "storage" in base or "auth" in base or "global.setup" in base
    ):
        return True
    return False


def resolve_e2e_file_paths(
    files: list,
    *,
    module: str = "",
    package_prefix: str | None = None,
    journey_slug: str = "journey",
    source_file_name: str | None = None,
    requirement_title: str = "",
    test_case_title: str = "",
) -> list:
    """
    Normalize LLM E2E paths:

      {suite}/_shared/pages|fixtures|types/…  — POM, auth, storage, shim
      {suite}/{Req}/{TC}/specs|playwright.config.ts — TC-local only

    Accepts objects with .path / .content / .kind (E2EFile) or dicts.
    """
    from app.llm.base import E2EFile

    root = e2e_module_root(
        module,
        package_prefix=package_prefix,
        source_file_name=source_file_name,
        requirement_title=requirement_title,
        test_case_title=test_case_title,
    )
    shared = e2e_shared_root(
        package_prefix=package_prefix, source_file_name=source_file_name
    )
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", journey_slug or "journey").strip("-") or "journey"
    out: list[E2EFile] = []
    seen: dict[str, int] = {}

    def _normalize_under_root(raw_path: str) -> str:
        """Collapse duplicated AItest/E2ETest prefixes; keep _shared tails intact."""
        p = _norm_rel(raw_path)
        if not p:
            return ""
        segs = [s for s in p.split("/") if s]
        low = [s.lower() for s in segs]
        kind_low = generated_test_root("e2e").lower()
        pairs: list[tuple[int, int]] = []
        for i in range(len(segs) - 1):
            if low[i] == AITEST_ROOT.lower() and low[i + 1] == kind_low:
                pairs.append((i, i + 1))
        if not pairs:
            return p
        last_ai, last_kind = pairs[-1]
        tail = segs[last_kind + 1 :]
        # Already under _shared — re-root to canonical shared
        if tail and tail[0].lower() == "_shared":
            rest = tail[1:]
            return "/".join([shared] + rest).replace("//", "/") if rest else shared
        base = root.split("/")
        if tail and base and tail[0].lower() == base[-1].lower():
            tail = tail[1:]
        if tail:
            return "/".join(base + tail).replace("//", "/")
        return root

    def _route_final(path: str, kind: str, base_name: str) -> tuple[str, str]:
        """Return (final_path, kind) under shared or TC root."""
        low = path.lower()
        leaf = base_name or ""

        if low.endswith("playwright.config.ts") or low.endswith("playwright.config.js") or kind == "config":
            return f"{root}/playwright.config.ts", "config"

        if leaf.lower() == "playwright-shim.d.ts" or (
            "/types/" in f"/{low}/" and "shim" in leaf.lower()
        ):
            return f"{shared}/types/playwright-shim.d.ts", "fixture"

        if leaf.lower() == "auth.helper.ts":
            return f"{shared}/fixtures/auth.helper.ts", "fixture"

        if leaf.lower() in ("storagestate.json", "global.setup.ts") or (
            leaf.lower().startswith("storagestate") and leaf.lower().endswith(".json")
        ):
            return f"{shared}/fixtures/{leaf}", "fixture"

        if (
            kind == "page"
            or leaf.endswith(".page.ts")
            or low.startswith("pages/")
            or "/pages/" in f"/{low}/"
        ):
            name = leaf or f"{slug}.page.ts"
            return f"{shared}/pages/{name}", "page"

        if kind == "fixture" or low.startswith("fixtures/") or "/fixtures/" in f"/{low}/":
            name = leaf or "data.json"
            # Non-shared fixtures still go shared when auth/storage-like; else shared/fixtures
            return f"{shared}/fixtures/{name}", "fixture"

        if kind == "spec" or low.startswith("specs/") or "/specs/" in f"/{low}/":
            name = leaf or f"{slug}.spec.ts"
            if not name.endswith(".spec.ts") and not name.endswith(".test.ts"):
                name = f"{slug}.spec.ts"
            return f"{root}/specs/{name}", "spec"

        name = leaf or f"{slug}.spec.ts"
        if not name.endswith(".spec.ts") and not name.endswith(".test.ts"):
            name = f"{slug}.spec.ts"
        return f"{root}/specs/{name}", "spec"

    for item in files:
        if isinstance(item, E2EFile):
            path = item.path
            content = item.content
            kind = item.kind
        elif isinstance(item, dict):
            path = str(item.get("path") or "")
            content = str(item.get("content") or "")
            kind = str(item.get("kind") or "spec")
        else:
            continue
        path = _norm_rel(path)
        if not path or not content.strip():
            continue

        low = path.lower()
        base_name = os.path.basename(path)
        if "aitest/" in low and "e2etest" in low:
            path = _normalize_under_root(path)
            low = path.lower()
            base_name = os.path.basename(path)

        final, kind = _route_final(path, kind or "", base_name)
        final = final.replace("//", "/")
        if final in seen:
            idx = seen[final]
            out[idx] = E2EFile(path=final, content=content, kind=kind)
            continue
        seen[final] = len(out)
        out.append(E2EFile(path=final, content=content, kind=kind))

    # Shim under _shared/types (once)
    shim_path = f"{shared}/types/playwright-shim.d.ts".replace("//", "/")
    shim_content = (
        "declare module '@playwright/test' {\n"
        "  export const test: any;\n"
        "  export const expect: any;\n"
        "  export const devices: any;\n"
        "  export function defineConfig(config: any): any;\n"
        "  const _default: any;\n"
        "  export default _default;\n"
        "}\n"
        "declare const process: {\n"
        "  env: Record<string, string | undefined>;\n"
        "};\n"
    )
    if shim_path not in seen:
        seen[shim_path] = len(out)
        out.append(E2EFile(path=shim_path, content=shim_content, kind="fixture"))

    by_page_base: dict[str, str] = {}
    for f in out:
        p = f.path.replace("\\", "/")
        if "/pages/" not in p:
            continue
        base = os.path.splitext(os.path.basename(p))[0].lower()
        by_page_base[base] = p

    auth_helper_path = next(
        (
            f.path.replace("\\", "/")
            for f in out
            if f.path.replace("\\", "/").lower().endswith("auth.helper.ts")
        ),
        f"{shared}/fixtures/auth.helper.ts",
    )
    storage_shared = f"{shared}/fixtures/storageState.json"

    import_re = re.compile(r"""(from\s+['"])([^'"]+)(['"])""", re.MULTILINE)
    req_re = re.compile(r"""(require\(\s*['"])([^'"]+)(['"]\s*\))""", re.MULTILINE)

    def _norm_no_ext(spec: str) -> str:
        return re.sub(r"\.(tsx?|jsx?)$", "", spec.replace("\\", "/"), flags=re.IGNORECASE)

    def _rel_import(from_file: str, to_file: str) -> str:
        from_dir = os.path.dirname(from_file.replace("\\", "/")) or "."
        rel = os.path.relpath(to_file.replace("\\", "/"), from_dir).replace("\\", "/")
        rel = _norm_no_ext(rel)
        if not rel.startswith("."):
            rel = f"./{rel}"
        return rel

    def _normalize_spec_storage_state(text: str, spec_path: str) -> str:
        rel = _rel_import(spec_path, storage_shared)
        # keep .json extension in storageState string
        storage_rel = os.path.relpath(
            storage_shared, os.path.dirname(spec_path.replace("\\", "/")) or "."
        ).replace("\\", "/")
        if not storage_rel.startswith("."):
            storage_rel = f"./{storage_rel}"
        return re.sub(
            r"""(storageState\s*:\s*)(['"])[^'"]*\2""",
            rf'\1"{storage_rel}"',
            text,
            flags=re.IGNORECASE,
        )

    def _rewrite_to_page(spec_path: str, import_spec: str) -> str | None:
        raw = import_spec.strip()
        low = _norm_no_ext(raw).lower()
        if "node_modules" in low or low.startswith("@playwright/"):
            return None
        leaf = os.path.basename(low)
        if not leaf:
            return None
        candidates = [leaf]
        if leaf.endswith(".page"):
            candidates.append(leaf[:-5])
        if not leaf.endswith(".page"):
            candidates.append(f"{leaf}.page")
        page_path = None
        for c in candidates:
            page_path = by_page_base.get(c)
            if page_path:
                break
        if not page_path:
            return None
        return _rel_import(spec_path, page_path)

    def _rewrite_auth_helper(spec_path: str, import_spec: str) -> str | None:
        low = import_spec.strip().lower().replace("\\", "/")
        if "auth.helper" not in low:
            return None
        return _rel_import(spec_path, auth_helper_path)

    def _shim_ref_for(file_path: str) -> str:
        rel = os.path.relpath(
            shim_path, os.path.dirname(file_path.replace("\\", "/")) or "."
        ).replace("\\", "/")
        return f'/// <reference path="{rel}" />\n'

    fixed: list[E2EFile] = []
    for f in out:
        p = f.path.replace("\\", "/")
        content = f.content
        low_content = content.lower()
        if "@playwright/test" in low_content and "reference path=" not in low_content:
            if "/specs/" in p or "/pages/" in p or p.endswith("/playwright.config.ts"):
                content = f"{_shim_ref_for(p)}{content}"
        if f.kind == "spec" or "/specs/" in p:
            content = _normalize_spec_storage_state(content, p)

            def _from_repl(m: re.Match[str]) -> str:
                prefix, spec, suffix = m.group(1), m.group(2), m.group(3)
                new_spec = _rewrite_auth_helper(p, spec) or _rewrite_to_page(p, spec)
                if not new_spec:
                    return m.group(0)
                return f"{prefix}{new_spec}{suffix}"

            def _req_repl(m: re.Match[str]) -> str:
                prefix, spec, suffix = m.group(1), m.group(2), m.group(3)
                new_spec = _rewrite_auth_helper(p, spec) or _rewrite_to_page(p, spec)
                if not new_spec:
                    return m.group(0)
                return f"{prefix}{new_spec}{suffix}"

            content = import_re.sub(_from_repl, content)
            content = req_re.sub(_req_repl, content)
        elif f.kind == "config" or p.endswith("playwright.config.ts"):
            # Point storageState / globalSetup at _shared/fixtures
            storage_rel = os.path.relpath(
                storage_shared, os.path.dirname(p) or "."
            ).replace("\\", "/")
            if not storage_rel.startswith("."):
                storage_rel = f"./{storage_rel}"
            setup_rel = os.path.relpath(
                f"{shared}/fixtures/global.setup.ts", os.path.dirname(p) or "."
            ).replace("\\", "/")
            if not setup_rel.startswith("."):
                setup_rel = f"./{setup_rel}"
            content = re.sub(
                r"""(storageState\s*:\s*)(['"])[^'"]*\2""",
                rf'\1"{storage_rel}"',
                content,
                flags=re.IGNORECASE,
            )
            content = re.sub(
                r"""(globalSetup\s*:\s*)(['"])[^'"]*\2""",
                rf"\1'{setup_rel}'",
                content,
                flags=re.IGNORECASE,
            )
        fixed.append(E2EFile(path=f.path, content=content, kind=f.kind))

    return fixed


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


def assert_e2e_aitest_target_rel(target_rel: str) -> str:
    """EX3.2/3.4 — E2E Apply jail: under AItest/…/E2ETest/… only."""
    p = assert_safe_aitest_target_rel(target_rel)
    low_parts = [s.lower() for s in p.replace("\\", "/").split("/")]
    if "e2etest" not in low_parts:
        raise ValueError(f"Path jail E2E: must be under AItest/E2ETest/ (got {p})")
    return p
