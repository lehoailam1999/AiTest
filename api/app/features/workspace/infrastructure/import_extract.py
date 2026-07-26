"""Extract import / type dependency names from source text (heuristic, no full AST)."""

from __future__ import annotations

import re
from pathlib import Path

_CODE_EXT = {".cs", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".kt", ".go", ".rs", ".php"}

# Relative / package import specs to resolve against workspace
_TS_FROM = re.compile(
    r"""(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]"""
    r"""|require\s*\(\s*['"]([^'"]+)['"]\s*\)""",
    re.M,
)
_PY_FROM = re.compile(
    r"""^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))""",
    re.M,
)
_CS_USING = re.compile(r"""^\s*using\s+([\w.]+)\s*;""", re.M)
_JAVA_IMPORT = re.compile(r"""^\s*import\s+(?:static\s+)?([\w.]+)""", re.M)
_GO_IMPORT = re.compile(r"""^\s*import\s+(?:\w+\s+)?"([^"]+)""", re.M)
_RS_USE = re.compile(r"""^\s*use\s+([\w:]+)""", re.M)

# Constructor / field type names (DI hints)
_CTOR_TYPE = re.compile(
    r"""(?:private|public|protected|readonly|internal)\s+(?:readonly\s+)?([\w.]+)\s+\w+\s*[,)]"""
)
_TS_PARAM_TYPE = re.compile(
    r"""(?:private|public|protected|readonly)\s+(?:readonly\s+)?(?:\w+)\s*:\s*([\w.]+)"""
)
_PY_INIT_TYPE = re.compile(r"""(\w+)\s*:\s*([A-Z][\w.]+)""")


def normalize_rel(path: str) -> str:
    return (path or "").replace("\\", "/").lstrip("./")


def guess_language_from_path(path: str) -> str:
    ext = Path(normalize_rel(path)).suffix.lower()
    return {
        ".cs": "csharp",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".js": "javascript",
        ".jsx": "javascript",
        ".py": "python",
        ".java": "java",
        ".kt": "kotlin",
        ".go": "go",
        ".rs": "rust",
        ".php": "php",
    }.get(ext, "")


def extract_import_specs(content: str, *, path: str = "", language: str = "") -> list[str]:
    """Return import module specs / type names worth resolving to files."""
    lang = (language or guess_language_from_path(path) or "").lower()
    text = content or ""
    specs: list[str] = []

    if "python" in lang or path.endswith(".py"):
        for m in _PY_FROM.finditer(text):
            specs.append((m.group(1) or m.group(2) or "").strip())
        for m in _PY_INIT_TYPE.finditer(text):
            if m.group(1) != "self":
                specs.append(m.group(2))
    elif "c#" in lang or "csharp" in lang or path.endswith(".cs"):
        for m in _CS_USING.finditer(text):
            specs.append(m.group(1))
        for m in _CTOR_TYPE.finditer(text):
            specs.append(m.group(1))
    elif "java" in lang or "kotlin" in lang or path.endswith((".java", ".kt")):
        for m in _JAVA_IMPORT.finditer(text):
            specs.append(m.group(1))
    elif "go" in lang or path.endswith(".go"):
        for m in _GO_IMPORT.finditer(text):
            specs.append(m.group(1))
    elif "rust" in lang or path.endswith(".rs"):
        for m in _RS_USE.finditer(text):
            specs.append(m.group(1).replace("::", "."))
    else:
        for m in _TS_FROM.finditer(text):
            specs.append((m.group(1) or m.group(2) or "").strip())
        for m in _TS_PARAM_TYPE.finditer(text):
            specs.append(m.group(1))

    out: list[str] = []
    seen: set[str] = set()
    for s in specs:
        s = (s or "").strip().rstrip(";")
        if not s or s.startswith("node:") or s in ("react", "fs", "path", "os", "sys"):
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def resolve_relative_spec(spec: str, from_file: str) -> str | None:
    """Map ./foo or ../bar to a posix path without extension."""
    if not spec.startswith("."):
        return None
    from_norm = normalize_rel(from_file)
    base_dir = str(Path(from_norm).parent).replace("\\", "/")
    if base_dir == ".":
        base_dir = ""
    joined = str((Path(base_dir) / spec).as_posix()) if base_dir else spec
    # Normalize .. segments
    parts: list[str] = []
    for part in joined.replace("\\", "/").split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/".join(parts)


def candidate_paths_for_spec(spec: str, from_file: str) -> list[str]:
    """Expand one import spec into candidate relative paths to try/search."""
    rel = resolve_relative_spec(spec, from_file)
    stems: list[str] = []
    if rel:
        stems.append(rel)
        # drop extension if present
        p = Path(rel)
        if p.suffix.lower() in _CODE_EXT:
            stems.append(str(p.with_suffix("")).replace("\\", "/"))
    else:
        # package/module: take last 1–2 segments as file stem hints
        cleaned = spec.replace("\\", "/").replace("::", "/")
        segs = [s for s in cleaned.replace(".", "/").split("/") if s and s != "*"]
        if segs:
            stems.append(segs[-1])
            if len(segs) >= 2:
                stems.append(f"{segs[-2]}/{segs[-1]}")

    out: list[str] = []
    seen: set[str] = set()
    exts = [".ts", ".tsx", ".js", ".jsx", ".cs", ".py", ".java", ".go", ".rs", ".kt", ""]
    for stem in stems:
        stem_n = normalize_rel(stem)
        for ext in exts:
            cand = stem_n if not ext or stem_n.endswith(ext) else f"{stem_n}{ext}"
            # also index.ts style
            variants = [cand]
            if ext and not stem_n.endswith(ext):
                variants.append(f"{stem_n}/index{ext}")
            for v in variants:
                key = v.lower()
                if key in seen:
                    continue
                seen.add(key)
                out.append(v)
    return out


def search_tokens_for_spec(spec: str) -> list[str]:
    """Tokens to feed workspace search (by stem/name)."""
    cleaned = spec.replace("\\", "/").replace("::", ".")
    if cleaned.startswith("."):
        base = Path(cleaned).name
        return [base] if base and base not in (".", "..") else []
    segs = [s for s in cleaned.replace(".", "/").split("/") if s and s != "*"]
    if not segs:
        return []
    last = segs[-1]
    # Strip common suffixes for broader match
    alts = [last]
    for suf in ("Service", "Controller", "Repository", "Handler", "Client", "Manager"):
        if last.endswith(suf) and len(last) > len(suf) + 2:
            alts.append(last[: -len(suf)])
            break
    return alts
