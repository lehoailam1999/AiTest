"""Chọn primary + related paths từ TC — chỉ gửi danh sách path (không gửi source code)."""

from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[3]
_VI_IT_ALIASES_JSON = (
    _REPO_ROOT
    / "packages"
    / "ide-protocol"
    / "src"
    / "defaults"
    / "vi-it-aliases.json"
)


@lru_cache(maxsize=1)
def _load_vi_it_aliases() -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Shared SoT with @aitest/ide-protocol defaults/vi-it-aliases.json."""
    try:
        raw = json.loads(_VI_IT_ALIASES_JSON.read_text(encoding="utf-8"))
        words = raw.get("words") or {}
        phrases = raw.get("phrases") or {}
        if isinstance(words, dict) and isinstance(phrases, dict):
            return words, phrases
    except (OSError, json.JSONDecodeError):
        pass
    # Fallback if monorepo layout differs
    return (
        {"tao": ["Create", "Add", "New"], "tim": ["Search", "Find", "Query"]},
        {"dang nhap": ["Login", "Auth", "SignIn"], "tim kiem": ["Search", "Query"]},
    )


_GENERIC_VI_WORDS, _GENERIC_VI_PHRASES = _load_vi_it_aliases()

_STOP = {
    "the", "and", "for", "with", "from", "that", "this", "when", "then",
    "user", "test", "case", "step", "expected", "result", "system",
    "nhap", "vao", "cua", "cho", "voi", "khi", "thi", "cac", "mot",
    "nay", "duoc", "khong", "phai", "tren", "duoi", "sau", "truoc",
    "qua", "rest", "requirements",
}


def _strip_diacritics(s: str) -> str:
    t = unicodedata.normalize("NFD", s or "")
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return t.replace("đ", "d").replace("Đ", "D")


def _ascii_key(raw: str) -> str:
    return re.sub(
        r"\s+",
        " ",
        re.sub(r"[^a-z0-9\s]+", " ", _strip_diacritics(raw).lower()),
    ).strip()


def fallback_code_tokens_from_tc(
    *,
    title: str,
    module: str | None,
    steps: str = "",
    test_data: str | None = None,
    max_tokens: int = 24,
) -> list[str]:
    """
    Deterministic VI/Feature → code-ish tokens when AI mapping is unavailable.
    Prefer Latin identifiers that can match file stems/paths.
    """
    blob = " ".join(
        x for x in (module or "", title or "", steps or "", test_data or "") if x
    )
    ascii_blob = _ascii_key(blob)
    out: list[str] = []
    seen: set[str] = set()

    def add(tok: str) -> None:
        s = (tok or "").strip()
        if not s or len(s) > 64:
            return
        if not re.match(r"^[A-Za-z][A-Za-z0-9_.-]{1,63}$", s):
            return
        key = s.lower()
        if key in seen or key in _STOP:
            return
        seen.add(key)
        out.append(s)

    # Explicit hints: code: Foo / path: a/b.ts
    for m in re.finditer(
        r"(?i)\b(?:code|path|alias)\s*[:=]\s*([A-Za-z0-9_./\\-]+)",
        blob,
    ):
        add(m.group(1).replace("\\", "/").split("/")[-1].split(".")[0])

    for phrase, aliases in _GENERIC_VI_PHRASES.items():
        if phrase in ascii_blob:
            for a in aliases:
                add(a)

    words = [w for w in ascii_blob.split(" ") if len(w) >= 2]
    for w in words:
        if w in _STOP:
            continue
        add(w)
        for a in _GENERIC_VI_WORDS.get(w, []):
            add(a)

    if len(words) >= 2:
        add("".join(words[:4]))
        add("_".join(words[:4]))
        add("".join(w[:1].upper() + w[1:] for w in words[:4]))

    # Also keep original Latin tokens from module/title (PascalCase pieces)
    for part in re.findall(r"[A-Za-z][a-z]+|[A-Z]{2,}(?![a-z])|[A-Z][a-z]+", blob):
        add(part)

    return out[:max_tokens]


def build_resolve_tokens_prompts(
    *,
    title: str,
    module: str | None,
    steps: str,
    expected: str,
    precondition: str | None,
    test_data: str | None,
) -> tuple[str, str]:
    """TC tiếng Việt → token tiếng Anh / identifier để khớp tên file (không gửi source)."""
    system = (
        "Bạn là kỹ sư phần mềm. Nhiệm vụ: từ test case (thường tiếng Việt), suy ra các "
        "token định danh tiếng Anh thường dùng trong mã nguồn (class, file, folder, API).\n"
        "Không dịch cả câu — chỉ liệt kê identifier ngắn (PascalCase / camelCase / từ đơn).\n"
        "Gồm: danh từ nghiệp vụ (vd. vật chứng→Evidence), hành động (tạo→Create), lớp kỹ thuật "
        "(Service, Controller, Repository, DTO) nếu hợp lý.\n"
        "Trả về DUY NHẤT JSON (không markdown):\n"
        '{"tokens":["Evidence","Create","Service"],"reason":"ngắn bằng tiếng Việt"}\n'
        "tokens: 5–20 mục, ưu tiên từ khớp được tên file/class; không lặp; không câu dài."
    )
    lines = [
        f"## Test case\nTitle: {title}",
        f"Module/chức năng: {module or '—'}",
        f"Precondition: {precondition or '—'}",
        f"Steps:\n{steps or '—'}",
        f"Expected:\n{expected or '—'}",
        f"Test data: {test_data or '—'}",
    ]
    return system, "\n".join(lines)


def parse_resolve_tokens_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            raise ValueError("LLM không trả JSON hợp lệ (tokens)")
        data = json.loads(m.group(0))

    raw_tokens = data.get("tokens") or []
    if not isinstance(raw_tokens, list):
        raw_tokens = []
    tokens: list[str] = []
    seen: set[str] = set()
    for t in raw_tokens:
        s = str(t).strip()
        if not s or len(s) > 64:
            continue
        # chỉ lấy identifier-ish
        if not re.match(r"^[A-Za-z][A-Za-z0-9_.-]{1,63}$", s):
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        tokens.append(s)
        if len(tokens) >= 24:
            break

    return {
        "tokens": tokens,
        "reason": str(data.get("reason") or "").strip() or "AI map VI→code token",
    }


def build_resolve_scope_prompts(
    *,
    title: str,
    module: str | None,
    steps: str,
    expected: str,
    precondition: str | None,
    test_data: str | None,
    candidates: list[str],
) -> tuple[str, str]:
    system = (
        "Bạn là kỹ sư phần mềm. Nhiệm vụ: chọn file mã nguồn phù hợp để viết unit test "
        "cho một test case. Chỉ được chọn path từ danh sách ứng viên.\n"
        "Trả về DUY NHẤT JSON (không markdown):\n"
        '{"primary":"path/relative.ext","related":["path2","path3"],"reason":"ngắn bằng tiếng Việt"}\n'
        "related: tối đa 12 file phụ (interface, DTO, dependency gần). "
        "Nếu không chắc primary, chọn ứng viên khớp module/chức năng nhất."
    )
    lines = [
        f"## Test case\nTitle: {title}",
        f"Module/chức năng: {module or '—'}",
        f"Precondition: {precondition or '—'}",
        f"Steps:\n{steps or '—'}",
        f"Expected:\n{expected or '—'}",
        f"Test data: {test_data or '—'}",
        "",
        f"## Ứng viên ({len(candidates)} path — chỉ chọn trong list này)",
        *[f"- {p}" for p in candidates[:80]],
    ]
    return system, "\n".join(lines)


def parse_resolve_scope_json(raw: str, candidates: list[str]) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            raise ValueError("LLM không trả JSON hợp lệ")
        data = json.loads(m.group(0))

    cand_set = {c.replace("\\", "/") for c in candidates}
    primary = str(data.get("primary") or "").replace("\\", "/").strip()
    related_raw = data.get("related") or []
    if not isinstance(related_raw, list):
        related_raw = []

    def pick(path: str) -> str | None:
        p = path.replace("\\", "/").strip()
        if p in cand_set:
            return p
        for c in cand_set:
            if c.endswith("/" + p) or c.endswith(p) or p.endswith(c):
                return c
        return None

    primary_ok = pick(primary)
    related: list[str] = []
    for r in related_raw:
        hit = pick(str(r))
        if hit and hit != primary_ok and hit not in related:
            related.append(hit)
        if len(related) >= 12:
            break

    if not primary_ok and candidates:
        primary_ok = candidates[0].replace("\\", "/")

    return {
        "primary": primary_ok,
        "related": related,
        "reason": str(data.get("reason") or "").strip() or "AI xếp hạng path",
    }
