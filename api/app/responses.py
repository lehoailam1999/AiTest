from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi.responses import JSONResponse


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def ok(payload: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=_jsonable(payload))


def errors(status_code: int, *messages: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"errors": list(messages)})


def page(items: list, total: int, page_number: int, page_size: int) -> dict:
    if page_number < 1:
        page_number = 1
    if page_size < 1:
        page_size = 20
    total_pages = (total + page_size - 1) // page_size if page_size else 0
    return {
        "items": items,
        "pageNumber": page_number,
        "pageSize": page_size,
        "totalCount": total,
        "totalPages": total_pages,
        "hasPrevious": page_number > 1,
        "hasNext": page_number < total_pages,
    }


def page_params(page_q: str | None, size_q: str | None) -> tuple[int, int]:
    try:
        page_number = int(page_q) if page_q else 1
    except ValueError:
        page_number = 1
    try:
        page_size = int(size_q) if size_q else 20
    except ValueError:
        page_size = 20
    if page_number < 1:
        page_number = 1
    if page_size < 1:
        page_size = 20
    if page_size > 100:
        page_size = 100
    return page_number, page_size
