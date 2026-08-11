"""Approve Unit — grounded pick of primary path among index shortlist."""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.llm import LLMError
from app.models.domain import AiBackendConnection, Project
from app.responses import errors, ok
from app.services.connection_service import connection_api_key, llm_from_connection

router = APIRouter(prefix="/api", tags=["agent"], dependencies=[Depends(get_current_user)])
log = logging.getLogger("aitest.agent.pick_unit")


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


def _norm_path(p: str) -> str:
    return (p or "").replace("\\", "/").strip().lower()


def build_pick_unit_primary_prompts(
    *,
    requirement_title: str,
    module: str,
    title: str,
    steps: str,
    expected: str,
    candidates: list[dict[str, Any]],
) -> tuple[str, str]:
    lines = []
    for i, c in enumerate(candidates[:12], start=1):
        path = str(c.get("path") or "").replace("\\", "/")
        code = str(c.get("code") or path.rsplit("/", 1)[-1].rsplit(".", 1)[0])
        lines.append(f"{i}. path={path} code={code}")
    system = (
        "You pick the best Unit test primary SUT handler/service for a Test Case.\n"
        "You MUST choose exactly one path from the candidate list. Never invent paths.\n"
        "Prefer CommandHandler/Service matching Module/Title domain over Query/User/Account "
        "unless the TC is clearly about users/accounts.\n"
        "Vietnamese Module nouns map to Latin folder names when obvious from candidates "
        "(e.g. vật chứng → Evidence* if present in the list).\n"
        "Return ONLY JSON: {\"path\":\"...\",\"code\":\"...\",\"confidence\":0.0-1.0}\n"
        "If none fit, return {\"path\":null,\"code\":null,\"confidence\":0}."
    )
    user = "\n".join(
        [
            f"Module (requirement): {requirement_title or '—'}",
            f"Function: {module or '—'}",
            f"Title: {title or '—'}",
            f"Steps:\n{(steps or '—')[:1200]}",
            f"Expected:\n{(expected or '—')[:600]}",
            "",
            "Candidates (index only):",
            *lines,
        ]
    )
    return system, user


def parse_pick_unit_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return {"path": None, "code": None, "confidence": 0}
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return {"path": None, "code": None, "confidence": 0}
    if not isinstance(data, dict):
        return {"path": None, "code": None, "confidence": 0}
    path = data.get("path")
    code = data.get("code")
    try:
        conf = float(data.get("confidence") if data.get("confidence") is not None else 0)
    except (TypeError, ValueError):
        conf = 0.0
    return {
        "path": str(path).strip() if path else None,
        "code": str(code).strip() if code else None,
        "confidence": max(0.0, min(1.0, conf)),
    }


def accept_shortlist_pick(
    pick: dict[str, Any],
    candidates: list[dict[str, Any]],
    *,
    min_confidence: float = 0.7,
) -> dict[str, Any] | None:
    if not pick or not candidates:
        return None
    conf = float(pick.get("confidence") or 0)
    if conf < min_confidence:
        return None
    want = _norm_path(str(pick.get("path") or ""))
    if not want:
        return None
    for c in candidates:
        path = str(c.get("path") or "").replace("\\", "/")
        p = _norm_path(path)
        if p == want or p.endswith("/" + want) or want.endswith("/" + p):
            code = (
                str(pick.get("code") or "").strip()
                or str(c.get("code") or "").strip()
                or path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            )
            return {
                "path": path,
                "code": code,
                "confidence": conf,
                "source": "llm",
            }
    return None


@router.post("/agent/pick-unit-primary")
async def pick_unit_primary(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    Grounded Approve pick: AI chooses path ∈ candidates only.
    Body: { projectId, requirementTitle, module, title, steps, expectedResult, candidates:[{path,code,score}] }
    """
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    if project_id is None:
        return errors(400, "projectId required")

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if project is None:
        return errors(404, "Project not found")

    candidates_raw = body.get("candidates") or []
    if not isinstance(candidates_raw, list) or not candidates_raw:
        return errors(400, "candidates required (non-empty shortlist from index)")

    candidates: list[dict[str, Any]] = []
    for c in candidates_raw[:12]:
        if not isinstance(c, dict):
            continue
        path = str(c.get("path") or "").replace("\\", "/").strip()
        if not path:
            continue
        candidates.append(
            {
                "path": path,
                "code": str(c.get("code") or "").strip() or path.rsplit("/", 1)[-1].rsplit(".", 1)[0],
                "score": c.get("score") or 0,
            }
        )
    if not candidates:
        return errors(400, "no valid candidate paths")

    refuse = {"path": None, "code": None, "confidence": 0, "source": "refuse"}

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        log.info("pick-unit-primary: AI not ready — refuse project=%s", project_id)
        return ok(refuse)

    try:
        api_key = connection_api_key(conn)
        provider = llm_from_connection(conn)
    except (ValueError, LLMError) as exc:
        log.warning("pick-unit-primary connection error: %s", exc)
        return ok(refuse)

    system, user = build_pick_unit_primary_prompts(
        requirement_title=str(body.get("requirementTitle") or ""),
        module=str(body.get("module") or ""),
        title=str(body.get("title") or ""),
        steps=str(body.get("steps") or ""),
        expected=str(body.get("expectedResult") or ""),
        candidates=candidates,
    )
    try:
        # Approve pick is tiny JSON — keep latency bounded (full TC gen still uses defaults).
        raw = await provider.chat(
            api_key,
            system,
            user,
            max_tokens=384,
            timeout=25.0,
        )
        parsed = parse_pick_unit_json(raw)
        accepted = accept_shortlist_pick(parsed, candidates)
        if accepted is None:
            return ok(refuse)
        return ok(accepted)
    except Exception as exc:  # noqa: BLE001
        log.warning("pick-unit-primary LLM failed: %s", exc)
        return ok(refuse)
