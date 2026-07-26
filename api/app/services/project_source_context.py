from __future__ import annotations

import json

from app.llm.base import truncate


def source_files_from_project_meta(meta: str | None) -> list[tuple[str, str]]:
    # Deprecated: source code is no longer persisted in project meta.
    # Keep this helper as a harmless no-op for legacy imports.
    if meta:
        try:
            json.loads(meta)
        except json.JSONDecodeError:
            pass
    return []


def format_source_context_for_prompt(
    files: list[tuple[str, str]],
    *,
    max_files: int = 40,
    max_per_file: int = 5_000,
    max_total: int = 24_000,
) -> str | None:
    if not files:
        return None

    parts: list[str] = []
    total = 0
    for path, content in files[:max_files]:
        block = f"### {path}\n{truncate(content, max_per_file)}"
        if total + len(block) > max_total:
            break
        parts.append(block)
        total += len(block)

    if not parts:
        return None

    header = (
        "## Mã nguồn tham khảo\n"
        "Dùng để căn module, API, validation và luồng thực tế — không bịa endpoint/class không có trong code.\n"
        "Ưu tiên test case khớp hành vi code; nếu code và requirement mâu thuẫn, ghi chú trong precondition."
    )
    return header + "\n\n" + "\n\n".join(parts)
