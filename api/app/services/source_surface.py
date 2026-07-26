"""Light SUT surface extraction for Prompt Builder when contextPacket is absent."""

from __future__ import annotations

import re


def analyze_source_surface(
    *,
    path: str,
    content: str,
    language: str = "",
    test_case_title: str = "",
) -> dict[str, str | list[str]]:
    lang = (language or "").lower()
    text = content or ""
    symbol = _guess_symbol(path, text, lang)
    methods = _guess_methods(text, lang)[:16]
    deps = _guess_ctor_deps(text, lang)[:12]

    what_to_mock = deps[:]
    summary_parts = []
    if path:
        summary_parts.append(f"Path: {path}")
    if symbol:
        summary_parts.append(f"Symbol: {symbol}")
    if methods:
        summary_parts.append("Methods: " + ", ".join(methods))
    if deps:
        summary_parts.append("Constructor deps: " + ", ".join(deps))

    strategy_parts = []
    if test_case_title:
        strategy_parts.append(f"What to test: Cover Approved TC intent: {test_case_title}")
    elif symbol:
        strategy_parts.append(f"What to test: Unit-test visible surface of {symbol}")
    if what_to_mock:
        strategy_parts.append("Mock: " + ", ".join(what_to_mock))
    strategy_parts.append(
        "Do not mock: "
        + (f"{symbol} itself, " if symbol else "")
        + "pure helpers in the same file"
    )
    strategy_parts.append(
        "Forbidden:\n- invent APIs / types not present in primary or related snippets\n"
        "- write test beside production source — host places under AItest/UnitTest/{Module}/"
    )

    return {
        "symbol": symbol or "",
        "methods": methods,
        "constructorDeps": deps,
        "source_under_test_summary": "\n".join(summary_parts),
        "unit_strategy_summary": "\n".join(strategy_parts),
    }


def _guess_symbol(path: str, content: str, lang: str) -> str:
    base = path.replace("\\", "/").split("/")[-1]
    if "." in base:
        base = base.rsplit(".", 1)[0]
    if "python" in lang or path.endswith(".py"):
        m = re.search(r"^class\s+(\w+)", content, re.M)
        return m.group(1) if m else base
    if "c#" in lang or "csharp" in lang or path.endswith(".cs"):
        m = re.search(
            r"\b(?:public\s+)?(?:sealed\s+|abstract\s+|static\s+)?(?:partial\s+)?class\s+(\w+)",
            content,
        )
        return m.group(1) if m else base
    if "go" in lang or path.endswith(".go"):
        m = re.search(r"type\s+(\w+)\s+struct", content)
        return m.group(1) if m else base
    m = re.search(
        r"export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)|"
        r"export\s+(?:async\s+)?function\s+(\w+)|"
        r"export\s+const\s+(\w+)\s*=",
        content,
    )
    if m:
        return next(g for g in m.groups() if g)
    return base


def _guess_methods(content: str, lang: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    patterns: list[re.Pattern[str]]
    if "python" in lang:
        patterns = [re.compile(r"^\s{0,4}(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\(", re.M)]
    elif "c#" in lang or "csharp" in lang:
        patterns = [
            re.compile(
                r"public\s+(?:async\s+)?(?:static\s+)?(?:virtual\s+|override\s+)?"
                r"[\w<>,\[\]\s.]+\s+(\w+)\s*\("
            )
        ]
    elif "go" in lang:
        patterns = [
            re.compile(r"func\s+\([^)]+\)\s+([A-Z]\w*)\s*\("),
            re.compile(r"func\s+([A-Z]\w*)\s*\("),
        ]
    else:
        patterns = [
            re.compile(
                r"(?:public\s+|export\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*\([^)]*\)\s*"
                r"(?::\s*[\w<>,\s.|]+)?\s*\{"
            )
        ]
    skip = {"if", "for", "while", "switch", "catch", "constructor"}
    for pat in patterns:
        for m in pat.finditer(content):
            name = m.group(1)
            if not name or name in skip or name.startswith("_") or name in seen:
                continue
            seen.add(name)
            out.append(name)
    return out


def _guess_ctor_deps(content: str, lang: str) -> list[str]:
    out: list[str] = []
    if "c#" in lang or "csharp" in lang or content.find("public ") >= 0 and ".cs" in lang:
        m = re.search(
            r"(?:public|private|protected|internal)\s+\w+\s*\(([^)]*)\)\s*(?::\s*base\([^)]*\))?\s*\{",
            content,
        )
        if m:
            for part in m.group(1).split(","):
                t = re.search(r"([\w.<>]+)\s+\w+\s*$", part.strip())
                if t:
                    out.append(re.sub(r"<[^>]+>", "", t.group(1)))
    elif "python" in lang:
        m = re.search(r"def\s+__init__\s*\(self\s*,([^)]*)\)", content)
        if m:
            for part in m.group(1).split(","):
                t = re.search(r"(\w+)\s*:\s*([\w.\[\]]+)", part.strip())
                if t and t.group(1) != "self":
                    out.append(t.group(2))
    else:
        m = re.search(r"constructor\s*\(([^)]*)\)", content)
        if m:
            for part in m.group(1).split(","):
                t = re.search(
                    r"(?:private|public|protected|readonly)\s+(?:readonly\s+)?(\w+)\s*:\s*([\w.<>]+)",
                    part.strip(),
                )
                if t:
                    out.append(re.sub(r"<[^>]+>", "", t.group(2)))
                else:
                    u = re.search(r"(\w+)\s*:\s*([\w.<>]+)", part.strip())
                    if u:
                        out.append(re.sub(r"<[^>]+>", "", u.group(2)))
    return [d for d in dict.fromkeys(out) if d not in ("string", "int", "bool", "number")]
