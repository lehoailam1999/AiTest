"""Extract / clean JSON test-case payloads from CLI stdout."""

from __future__ import annotations

import json
import re
from typing import Any


def clean_and_parse_json_array(text: str) -> list[dict[str, Any]]:
    """
    Lọc markdown fences và lấy JSON array/object chứa test cases.
    Ưu tiên: ```json ... ``` → raw [ {...} ] → {"testCases":[...]}
    """
    raw = (text or "").strip()
    if not raw:
        raise ValueError("CLI output trống — không parse được JSON")

    # Strip common fences
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    if fenced:
        raw = fenced.group(1).strip()

    candidates: list[str] = [raw]
    arr = re.search(r"(\[\s*\{[\s\S]*\}\s*\])", raw)
    if arr:
        candidates.insert(0, arr.group(1))
    obj = re.search(r"(\{\s*\"testCases\"\s*:\s*\[[\s\S]*\]\s*\})", raw)
    if obj:
        candidates.insert(0, obj.group(1))

    last_err: Exception | None = None
    for cand in candidates:
        try:
            data = json.loads(cand)
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        if isinstance(data, dict):
            cases = data.get("testCases") or data.get("test_cases") or data.get("cases")
            if isinstance(cases, list):
                return [x for x in cases if isinstance(x, dict)]
            # single TC object
            if data.get("title") or data.get("steps"):
                return [data]
    raise ValueError(
        f"Không thể parse JSON từ kết quả CLI: {last_err}\n"
        f"Raw Output: {(text or '')[:500]}"
    )
