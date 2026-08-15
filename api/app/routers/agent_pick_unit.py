"""Approve Unit — grounded pick of primary path among index shortlist."""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.models.domain import AiBackendConnection, Project
from app.responses import errors, ok
from app.services.ai_service import chat_for_connection

router = APIRouter(prefix="/api", tags=["agent"], dependencies=[Depends(get_current_user)])
log = logging.getLogger("aitest.agent.pick_unit")


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


def _norm_path(p: str) -> str:
    return (p or "").replace("\\", "/").strip().lower()


def _normalize_primary_candidates(raw: Any, *, cap: int = 12) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    candidates: list[dict[str, Any]] = []
    for c in raw[:cap]:
        if not isinstance(c, dict):
            continue
        path = str(c.get("path") or "").replace("\\", "/").strip()
        if not path:
            continue
        candidates.append(
            {
                "path": path,
                "code": str(c.get("code") or "").strip()
                or path.rsplit("/", 1)[-1].rsplit(".", 1)[0],
                "score": c.get("score") or 0,
                "symbols": [
                    str(s).strip()
                    for s in (c.get("symbols") or [])[:32]
                    if str(s).strip()
                ],
                "excerpt": str(c.get("excerpt") or "")[:1200],
                "properties": [
                    {
                        "name": str(p.get("name") or "").strip(),
                        "ownerPath": str(p.get("ownerPath") or "")
                        .replace("\\", "/")
                        .strip(),
                        "ownerType": str(p.get("ownerType") or "").strip(),
                    }
                    for p in (c.get("properties") or [])[:24]
                    if isinstance(p, dict) and str(p.get("name") or "").strip()
                ],
            }
        )
    return candidates


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
        excerpt = str(c.get("excerpt") or "")[:2400]
        properties = c.get("properties") or []
        property_names = [
            str(p.get("name") or "").strip()
            for p in properties
            if isinstance(p, dict) and str(p.get("name") or "").strip()
        ]
        block = [f"{i}. path={path} code={code}"]
        if excerpt:
            block.append(f"SOURCE:\n{excerpt}")
        if property_names:
            block.append("PROPERTIES: " + ", ".join(property_names[:24]))
        lines.append("\n".join(block))
    system = (
        "You pick the best Unit test primary SUT handler/service for a Test Case.\n"
        "You MUST choose exactly one path from the candidate list. Never invent paths.\n"
        "Use only the supplied source evidence; do not rely on product-specific assumptions.\n"
        "The chosen code type must be defined by the same candidate path.\n"
        "Choose property only from PROPERTIES attached to the chosen candidate.\n"
        "Evidence must be a short exact quote copied from the chosen SOURCE.\n"
        "Return ONLY JSON: {\"path\":\"...\",\"code\":\"...\",\"property\":\"...|null\","
        "\"evidence\":\"exact quote\",\"confidence\":0.0-1.0}\n"
        "If none fit, return {\"path\":null,\"code\":null,\"property\":null,"
        "\"evidence\":null,\"confidence\":0}."
    )
    user = "\n".join(
        [
            f"Module (requirement): {requirement_title or '—'}",
            f"Function: {module or '—'}",
            f"Title: {title or '—'}",
            f"Steps:\n{(steps or '—')[:1200]}",
            f"Expected:\n{(expected or '—')[:600]}",
            "",
            "Candidates (index shortlist with bounded source evidence):",
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
            return {"path": None, "code": None, "property": None, "evidence": None, "confidence": 0}
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return {"path": None, "code": None, "property": None, "evidence": None, "confidence": 0}
    if not isinstance(data, dict):
        return {"path": None, "code": None, "property": None, "evidence": None, "confidence": 0}
    path = data.get("path")
    code = data.get("code")
    prop = data.get("property")
    evidence = data.get("evidence")
    try:
        conf = float(data.get("confidence") if data.get("confidence") is not None else 0)
    except (TypeError, ValueError):
        conf = 0.0
    return {
        "path": str(path).strip() if path else None,
        "code": str(code).strip() if code else None,
        "property": str(prop).strip() if prop else None,
        "evidence": str(evidence).strip() if evidence else None,
        "confidence": max(0.0, min(1.0, conf)),
    }


def build_pick_unit_field_prompts(
    *,
    field_label: str,
    input_keys: list[str],
    title: str,
    steps: str,
    primary_path: str,
    candidates: list[str],
) -> tuple[str, str]:
    lines = [f"{i}. {p}" for i, p in enumerate(candidates[:24], start=1)]
    keys = ", ".join(input_keys[:12]) if input_keys else "—"
    system = (
        "You pick the best backend DTO/command property for a Unit validation Test Case.\n"
        "You MUST choose exactly one property name from the candidate list. Never invent names.\n"
        "Match the human field label / input keys / title meaning to the Latin property "
        "(e.g. a Vietnamese label for an evidence code maps to EvidenceCode if that is in the list).\n"
        "Return ONLY JSON: {\"property\":\"...\",\"confidence\":0.0-1.0}\n"
        "If none fit, return {\"property\":null,\"confidence\":0}."
    )
    user = "\n".join(
        [
            f"Field label: {field_label or '—'}",
            f"Input keys: {keys}",
            f"Title: {title or '—'}",
            f"Primary path: {primary_path or '—'}",
            f"Steps:\n{(steps or '—')[:800]}",
            "",
            "Candidates (index DTO properties only):",
            *lines,
        ]
    )
    return system, user


def parse_pick_field_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            return {"property": None, "confidence": 0}
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return {"property": None, "confidence": 0}
    if not isinstance(data, dict):
        return {"property": None, "confidence": 0}
    prop = data.get("property")
    try:
        conf = float(data.get("confidence") if data.get("confidence") is not None else 0)
    except (TypeError, ValueError):
        conf = 0.0
    return {
        "property": str(prop).strip() if prop else None,
        "confidence": max(0.0, min(1.0, conf)),
    }


def accept_field_shortlist_pick(
    pick: dict[str, Any],
    candidates: list[str],
    *,
    min_confidence: float = 0.7,
) -> dict[str, Any] | None:
    if not pick or not candidates:
        return None
    conf = float(pick.get("confidence") or 0)
    if conf < min_confidence:
        return None
    want = str(pick.get("property") or "").strip()
    if not want:
        return None
    want_l = want.lower()
    for c in candidates:
        name = str(c or "").strip()
        if name and name.lower() == want_l:
            return {"property": name, "confidence": conf, "source": "llm"}
    return None


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
            )
            type_name = code.split(".", 1)[0].strip().lower()
            allowed_symbols = {
                str(s or "").strip().lower()
                for s in (c.get("symbols") or [])
                if str(s or "").strip()
            }
            candidate_type = str(c.get("code") or "").split(".", 1)[0].strip().lower()
            if candidate_type:
                allowed_symbols.add(candidate_type)
            if not type_name or type_name not in allowed_symbols:
                return None
            excerpt = str(c.get("excerpt") or "").strip()
            evidence = str(pick.get("evidence") or "").strip()
            if excerpt and (not evidence or evidence.lower() not in excerpt.lower()):
                return None
            property_name = str(pick.get("property") or "").strip()
            allowed_properties = {
                str(prop.get("name") or "").strip().lower(): str(prop.get("name") or "").strip()
                for prop in (c.get("properties") or [])
                if isinstance(prop, dict) and str(prop.get("name") or "").strip()
            }
            accepted_property = allowed_properties.get(property_name.lower()) if property_name else None
            if property_name and accepted_property is None:
                return None
            return {
                "path": path,
                "code": code,
                "property": accepted_property,
                "evidence": evidence or None,
                "confidence": conf,
                "source": "llm",
            }
    return None


def _parse_batch_results(raw: str) -> list[dict[str, Any]]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return []
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return []
    results = data.get("results") if isinstance(data, dict) else data
    return [item for item in results if isinstance(item, dict)] if isinstance(results, list) else []


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

    candidates = _normalize_primary_candidates(candidates_raw)
    if not candidates:
        return errors(400, "no valid candidate paths")

    refuse = {
        "path": None,
        "code": None,
        "property": None,
        "evidence": None,
        "confidence": 0,
        "source": "refuse",
    }

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        log.info("pick-unit-primary: AI not ready — refuse project=%s", project_id)
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
        raw, _meta = await chat_for_connection(conn, system, user)
        parsed = parse_pick_unit_json(raw)
        accepted = accept_shortlist_pick(parsed, candidates)
        if accepted is None:
            return ok(refuse)
        return ok(accepted)
    except Exception as exc:  # noqa: BLE001
        log.warning("pick-unit-primary CLI failed: %s", exc)
        return ok(refuse)


@router.post("/agent/pick-unit-grounding-batch")
async def pick_unit_grounding_batch(
    request: Request, db: Annotated[Session, Depends(get_db)]
):
    """One CLI invocation resolves path, code and optional property for up to 10 TCs."""
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    if project_id is None:
        return errors(400, "projectId required")
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return errors(404, "Project not found")
    items_raw = body.get("items") or []
    if not isinstance(items_raw, list) or not items_raw:
        return errors(400, "items required")

    items: list[dict[str, Any]] = []
    for position, raw_item in enumerate(items_raw[:10]):
        if not isinstance(raw_item, dict):
            continue
        candidates = _normalize_primary_candidates(raw_item.get("candidates"), cap=5)
        if not candidates:
            continue
        items.append(
            {
                "id": position,
                "requirementTitle": str(raw_item.get("requirementTitle") or "")[:300],
                "module": str(raw_item.get("module") or "")[:300],
                "title": str(raw_item.get("title") or "")[:500],
                "steps": str(raw_item.get("steps") or "")[:600],
                "expectedResult": str(raw_item.get("expectedResult") or "")[:300],
                "candidates": candidates,
            }
        )
    refuse = {
        "path": None,
        "code": None,
        "property": None,
        "evidence": None,
        "confidence": 0,
        "source": "refuse",
    }
    output = [dict(refuse) for _ in items_raw[:10]]
    if not items:
        return ok({"results": output})

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return ok({"results": output})

    prompt_blocks: list[str] = []
    for item in items:
        _system, item_user = build_pick_unit_primary_prompts(
            requirement_title=item["requirementTitle"],
            module=item["module"],
            title=item["title"],
            steps=item["steps"],
            expected=item["expectedResult"],
            candidates=item["candidates"],
        )
        prompt_blocks.append(f"ITEM id={item['id']}\n{item_user}")
    system = (
        "Resolve each Unit Test Case independently from its bounded candidate evidence.\n"
        "For every item choose path only from that item's candidates, code only when the type "
        "is defined by the same path, and property only from that candidate's PROPERTIES.\n"
        "Evidence must be a short exact quote copied from the chosen SOURCE. Never invent.\n"
        "Return ONLY JSON: {\"results\":[{\"id\":0,\"path\":\"...|null\","
        "\"code\":\"...|null\",\"property\":\"...|null\",\"evidence\":\"...|null\","
        "\"confidence\":0.0-1.0}]} with exactly one result per item."
    )
    try:
        raw, _meta = await chat_for_connection(conn, system, "\n\n".join(prompt_blocks))
        parsed = _parse_batch_results(raw)
        parsed_by_id = {
            int(item.get("id")): item
            for item in parsed
            if isinstance(item.get("id"), int)
        }
        for item in items:
            accepted = accept_shortlist_pick(
                parsed_by_id.get(item["id"]) or {}, item["candidates"]
            )
            if accepted is not None:
                output[item["id"]] = accepted
        return ok({"results": output})
    except Exception as exc:  # noqa: BLE001
        log.warning("pick-unit-grounding-batch CLI failed: %s", exc)
        return ok({"results": output})


@router.post("/agent/pick-unit-field-batch")
async def pick_unit_field_batch(
    request: Request, db: Annotated[Session, Depends(get_db)]
):
    """One CLI invocation resolves field properties for up to 10 grounded TCs."""
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    if project_id is None:
        return errors(400, "projectId required")
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return errors(404, "Project not found")
    items_raw = body.get("items") or []
    if not isinstance(items_raw, list) or not items_raw:
        return errors(400, "items required")
    refuse = {"property": None, "confidence": 0, "source": "refuse"}
    output = [dict(refuse) for _ in items_raw[:10]]
    items: list[dict[str, Any]] = []
    for position, raw_item in enumerate(items_raw[:10]):
        if not isinstance(raw_item, dict):
            continue
        names: list[str] = []
        seen: set[str] = set()
        for candidate in (raw_item.get("candidates") or [])[:24]:
            name = (
                str(candidate.get("property") or "").strip()
                if isinstance(candidate, dict)
                else str(candidate or "").strip()
            )
            if (
                not name
                or not re.match(r"^[A-Za-z_][\w]*$", name)
                or name.lower() in seen
            ):
                continue
            seen.add(name.lower())
            names.append(name)
        if not names:
            continue
        items.append(
            {
                "id": position,
                "fieldLabel": str(raw_item.get("fieldLabel") or "")[:300],
                "inputKeys": [
                    str(key).strip()
                    for key in (raw_item.get("inputKeys") or [])[:12]
                    if str(key).strip()
                ],
                "title": str(raw_item.get("title") or "")[:500],
                "steps": str(raw_item.get("steps") or "")[:600],
                "primaryPath": str(raw_item.get("primaryPath") or "")[:500],
                "candidates": names,
            }
        )
    if not items:
        return ok({"results": output})
    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return ok({"results": output})
    blocks: list[str] = []
    for item in items:
        _system, item_user = build_pick_unit_field_prompts(
            field_label=item["fieldLabel"],
            input_keys=item["inputKeys"],
            title=item["title"],
            steps=item["steps"],
            primary_path=item["primaryPath"],
            candidates=item["candidates"],
        )
        blocks.append(f"ITEM id={item['id']}\n{item_user}")
    system = (
        "Resolve every item independently. Choose property exactly from that item's candidates; "
        "never invent names or use product-specific assumptions.\n"
        "Return ONLY JSON: {\"results\":[{\"id\":0,\"property\":\"...|null\","
        "\"confidence\":0.0-1.0}]} with one result per item."
    )
    try:
        started = time.perf_counter()
        raw, _meta = await chat_for_connection(conn, system, "\n\n".join(blocks))
        parsed = _parse_batch_results(raw)
        parsed_by_id: dict[int, dict[str, Any]] = {}
        for parsed_item in parsed:
            raw_id = parsed_item.get("id")
            if isinstance(raw_id, int) or (
                isinstance(raw_id, str) and raw_id.strip().isdigit()
            ):
                parsed_by_id[int(raw_id)] = parsed_item
        for item in items:
            accepted = accept_field_shortlist_pick(
                parsed_by_id.get(item["id"]) or {}, item["candidates"]
            )
            if accepted is not None:
                output[item["id"]] = accepted
        accepted_count = sum(1 for item in output if item.get("source") == "llm")
        log.info(
            "pick-unit-field-batch items=%d parsed=%d accepted=%d elapsed_ms=%d",
            len(items),
            len(parsed),
            accepted_count,
            int((time.perf_counter() - started) * 1000),
        )
        if not parsed:
            log.warning(
                "pick-unit-field-batch returned unparseable CLI output: %r",
                (raw or "")[:240],
            )
        return ok({"results": output})
    except Exception as exc:  # noqa: BLE001
        log.warning("pick-unit-field-batch CLI failed: %s", exc)
        return ok({"results": output})


@router.post("/agent/pick-unit-field")
async def pick_unit_field(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    Grounded Approve pick: AI chooses DTO property ∈ candidates only.
    Body: { projectId, fieldLabel, inputKeys[], title?, steps?, primaryPath?,
            candidates:[{property}] | [string] }
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
        return errors(400, "candidates required (non-empty property shortlist from index)")

    candidates: list[str] = []
    seen: set[str] = set()
    for c in candidates_raw[:24]:
        if isinstance(c, dict):
            name = str(c.get("property") or c.get("name") or "").strip()
        else:
            name = str(c or "").strip()
        if not name or not re.match(r"^[A-Za-z_][\w]*$", name):
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        candidates.append(name)
    if not candidates:
        return errors(400, "no valid candidate properties")

    refuse = {"property": None, "confidence": 0, "source": "refuse"}

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        log.info("pick-unit-field: AI not ready — refuse project=%s", project_id)
        return ok(refuse)

    input_keys_raw = body.get("inputKeys") or body.get("input_keys") or []
    input_keys = (
        [str(k).strip() for k in input_keys_raw if str(k).strip()]
        if isinstance(input_keys_raw, list)
        else []
    )

    system, user = build_pick_unit_field_prompts(
        field_label=str(body.get("fieldLabel") or body.get("field_label") or ""),
        input_keys=input_keys,
        title=str(body.get("title") or ""),
        steps=str(body.get("steps") or ""),
        primary_path=str(body.get("primaryPath") or body.get("primary_path") or ""),
        candidates=candidates,
    )
    try:
        raw, _meta = await chat_for_connection(conn, system, user)
        parsed = parse_pick_field_json(raw)
        accepted = accept_field_shortlist_pick(parsed, candidates)
        if accepted is None:
            return ok(refuse)
        return ok(accepted)
    except Exception as exc:  # noqa: BLE001
        log.warning("pick-unit-field CLI failed: %s", exc)
        return ok(refuse)
