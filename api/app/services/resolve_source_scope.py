"""Chọn primary + related paths từ TC — chỉ gửi danh sách path (không gửi source code)."""

from __future__ import annotations

import json
import re
from typing import Any


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
