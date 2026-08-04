"""Lightweight phase timing helpers for Analysis / TC gen performance logs."""

from __future__ import annotations

import time
from typing import Any


def now_ms() -> float:
    return time.perf_counter() * 1000.0


def elapsed_ms(started: float) -> int:
    return max(0, int(time.perf_counter() * 1000.0 - started))


def timing_dict(**parts: int | str | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in parts.items():
        if v is None:
            continue
        out[k] = v
    return out
