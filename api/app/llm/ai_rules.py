"""
AI Rules — 3 tầng (System / Project / User).

System: cố định trong BE (tc_generation_rules, *_system_prompt, e2e guards) — không sửa từ UI.
Project: auto từ scan stack + ghi chú dự án (project.meta.aiRules).
User: người dùng chỉnh trên UI (project.meta.aiRules.user).

Thứ tự inject (ưu tiên khi xung đột): System > Project > User.
Tài liệu / source code là job context — không nhét vào tầng rule.
"""

from __future__ import annotations

import json
from typing import Any

# Caps — giữ rule ngắn; context job (freeze/source) mới mang chi tiết dài.
_CAP_SYSTEM_EXTRA = 4000
_CAP_PROJECT = 2000
_CAP_USER = 2000


def _truncate(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    return s[:n] + "\n…[truncated]"


def parse_project_meta(raw: str | dict | None) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return dict(raw)
    text = str(raw).strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def dumps_project_meta(meta: dict[str, Any] | None) -> str:
    return json.dumps(meta or {}, ensure_ascii=False)


def _ai_rules_blob(meta: dict[str, Any] | None) -> dict[str, Any]:
    m = meta or {}
    blob = m.get("aiRules")
    return blob if isinstance(blob, dict) else {}


def build_project_rules_text(meta: dict[str, Any] | None) -> str:
    """Project tier: auto (scan) + optional extra notes."""
    ar = _ai_rules_blob(meta)
    parts: list[str] = []
    auto = str(ar.get("projectAuto") or "").strip()
    extra = str(ar.get("projectExtra") or "").strip()
    if auto:
        parts.append(auto)
    if extra:
        parts.append(extra)
    # Fallback: synthesize a short auto block from scan fields if never seeded
    if not parts:
        synthesized = synthesize_project_auto_rules(meta or {})
        if synthesized:
            parts.append(synthesized)
    return "\n\n".join(parts).strip()


def build_user_rules_text(meta: dict[str, Any] | None) -> str:
    ar = _ai_rules_blob(meta)
    return str(ar.get("user") or "").strip()


def synthesize_project_auto_rules(meta: dict[str, Any]) -> str:
    """
    Document-agnostic project rules from stack scan / language / frameworks.
    Safe to regenerate on each sync (unless lockProjectAuto).
    """
    lines: list[str] = ["QUY TẮC DỰ ÁN (auto — từ stack scan):"]
    lang = str(meta.get("scanLanguage") or "").strip()
    # Prefer explicit fields often mirrored on Project row via caller
    frameworks = meta.get("frameworks") or []
    test_fws = meta.get("testFrameworks") or []
    stacks = meta.get("stacks") or []
    modules = meta.get("modules") or []

    if lang:
        lines.append(f"- Ngôn ngữ chính (scan): {lang}.")
    if frameworks:
        fw = ", ".join(str(x) for x in frameworks[:8] if x)
        if fw:
            lines.append(f"- Framework ứng dụng: {fw}.")
    if test_fws:
        tf = ", ".join(str(x) for x in test_fws[:8] if x)
        if tf:
            lines.append(f"- Test framework phát hiện: {tf}. Ưu tiên khi sinh / verify code test.")
    if stacks:
        st = ", ".join(str(x) for x in stacks[:10] if x)
        if st:
            lines.append(f"- Stack markers: {st}.")
    if isinstance(modules, list) and modules:
        names: list[str] = []
        for m in modules[:12]:
            if isinstance(m, dict) and m.get("name"):
                names.append(str(m["name"]))
            elif isinstance(m, str) and m.strip():
                names.append(m.strip())
        if names:
            lines.append(f"- Module/package gợi ý: {', '.join(names)}.")

    e2e = meta.get("e2e") if isinstance(meta.get("e2e"), dict) else {}
    if e2e.get("targetUrl"):
        lines.append(f"- E2E targetUrl mặc định: {e2e.get('targetUrl')}.")
    if e2e.get("useStorageState") is True:
        lines.append("- E2E: ưu tiên storageState (không lặp login UI trên feature Spec).")
    elif e2e.get("useStorageState") is False:
        lines.append("- E2E: không dùng storageState — auth qua ensureAuthenticated / UI khi cần.")

    lines.append(
        "- Layout artifact: Unit → AItest/UnitTest/{Requirement}/{TC}/ ; "
        "E2E → AItest/E2ETest/{Requirement}/{TC}/specs + _shared/{pages|fixtures}."
    )
    lines.append(
        "- Unit: không import/chạy entrypoint bootstrap (main.ts/js, Program.cs, wsgi/asgi, …); "
        "ưu tiên pipe/controller/service/validator. Tuỳ chỉnh thêm đường dẫn cấm trong Project Extra."
    )
    lines.append(
        "- Chỉ bám tài liệu job (TC) hoặc source/DOM (codegen) — không copy domain mẫu."
    )

    # If almost empty (only header + 2 generic lines), still OK
    if len(lines) <= 3 and not lang and not frameworks and not test_fws:
        return ""
    return "\n".join(lines)


def seed_ai_rules_on_meta(
    meta: dict[str, Any] | None,
    *,
    language: str | None = None,
    force_auto: bool = False,
) -> dict[str, Any]:
    """
    Merge scan-derived projectAuto into meta.aiRules.
    Preserves user + projectExtra; respects lockProjectAuto.
    """
    out = dict(meta or {})
    if language:
        out["scanLanguage"] = language
    ar = dict(_ai_rules_blob(out))
    locked = bool(ar.get("lockProjectAuto"))
    auto = synthesize_project_auto_rules(out)
    if auto and (force_auto or not locked or not str(ar.get("projectAuto") or "").strip()):
        ar["projectAuto"] = auto
    # Keep existing user / projectExtra / lock
    out["aiRules"] = ar
    return out


def format_layered_rules_block(
    *,
    system_extra: str = "",
    project_rules: str = "",
    user_rules: str = "",
    system_label: str = "QUY TẮC HỆ THỐNG (System — không sửa từ UI)",
    project_label: str = "QUY TẮC DỰ ÁN (Project)",
    user_label: str = "QUY TẮC NGƯỜI DÙNG (User)",
) -> str:
    """
    Concatenate labeled tiers. Precedence reminder when multiple present.
    """
    parts: list[str] = []
    sys_t = (system_extra or "").strip()
    proj_t = (project_rules or "").strip()
    user_t = (user_rules or "").strip()

    if sys_t:
        parts.append(f"{system_label}:\n{_truncate(sys_t, _CAP_SYSTEM_EXTRA)}")
    if proj_t:
        parts.append(f"{project_label}:\n{_truncate(proj_t, _CAP_PROJECT)}")
    if user_t:
        parts.append(f"{user_label}:\n{_truncate(user_t, _CAP_USER)}")

    if not parts:
        return ""

    head = ""
    if sum(1 for x in (sys_t, proj_t, user_t) if x) >= 2:
        head = (
            "Thứ tự ưu tiên khi xung đột: System > Project > User. "
            "User/Project không được phá contract System (schema, locator, engine lock).\n\n"
        )
    return head + "\n\n".join(parts)


def append_layered_rules(
    prompt: str,
    *,
    system_extra: str = "",
    project_rules: str = "",
    user_rules: str = "",
) -> str:
    """Append 3-tier block to an existing system prompt string."""
    block = format_layered_rules_block(
        system_extra=system_extra,
        project_rules=project_rules,
        user_rules=user_rules,
    )
    if not block:
        return prompt
    return f"{prompt.rstrip()}\n\n{block}\n"


def merge_project_meta(
    existing_raw: str | dict | None,
    incoming: Any,
) -> dict[str, Any]:
    """
    Shallow-merge project.meta JSON; deep-merge aiRules so partial PUTs
    (e.g. only e2e) do not wipe user/projectAuto.
    """
    existing = parse_project_meta(existing_raw)
    if incoming is None:
        return existing
    if isinstance(incoming, str):
        incoming = parse_project_meta(incoming)
    if not isinstance(incoming, dict):
        return existing
    merged = {**existing, **incoming}
    ar_old = existing.get("aiRules") if isinstance(existing.get("aiRules"), dict) else {}
    if "aiRules" in incoming:
        ar_new = incoming.get("aiRules")
        if isinstance(ar_new, dict):
            merged["aiRules"] = {**ar_old, **ar_new}
        elif ar_new is None:
            merged["aiRules"] = dict(ar_old)
    return merged


def rules_pair_from_meta(
    meta: dict[str, Any] | None,
    *,
    language: str | None = None,
) -> tuple[str, str]:
    """Return (project_rules, user_rules) for prompt injection."""
    m = dict(meta or {})
    if language:
        m.setdefault("scanLanguage", language)
    return build_project_rules_text(m), build_user_rules_text(m)
