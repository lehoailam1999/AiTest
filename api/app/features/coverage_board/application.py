"""Server-side Coverage Board aggregate (F0.3 · F6).

Hierarchy: Yeu cau (Requirement) -> Chuc nang (topic/module) -> Test case.
User-facing hub path: /requirement · Unit test: /unit-test
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any
from urllib.parse import urlencode

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.models.domain import (
    Execution,
    Project,
    RequirementTopic,
    Source,
    TestCase,
    WorkspaceRun,
)
from app.services.requirement_content import normalize_function_label
from app.services.requirement_topics import topics_from_description

UNMODULED = "(chưa gán chức năng)"


def _norm_display(raw: str | None) -> str:
    t = normalize_function_label(raw)
    return t if t else UNMODULED


def _merge_key(display: str) -> str:
    if display == UNMODULED:
        return UNMODULED
    n = normalize_function_label(display)
    return n.lower() if n else UNMODULED


def _tc_status(total: int, approved: int, draft: int) -> str:
    if total == 0:
        return "none"
    if approved == 0:
        return "draft_heavy"
    if draft > 0 or approved < total:
        return "partial"
    return "ready"


def _code_status(
    approved: int, applied: int, staged: int, verified: int
) -> str:
    if approved == 0:
        if applied > 0:
            return "applied_partial"
        if verified > 0:
            return "verified"
        if staged > 0:
            return "staged"
        return "none"
    if applied >= approved and approved >= 1:
        return "applied"
    if applied > 0 and applied < approved:
        return "applied_partial"
    if verified > 0:
        return "verified"
    if staged > 0:
        return "staged"
    return "none"


def _project_run_status(execs: list[Execution]) -> str:
    if not execs:
        return "none"
    s = (execs[0].status or "").lower()
    if s in ("passed", "pass", "success"):
        return "passing"
    if s in ("failed", "fail", "error"):
        return "failing"
    return "none"


def _generate_tc_path(requirement_id: str | None, module: str | None) -> str:
    q: dict[str, str] = {}
    if requirement_id:
        q["requirementId"] = requirement_id
    if module:
        q["module"] = module
        q["scope"] = "module"
    return "/generate/tc?" + urlencode(q) if q else "/generate/tc"


def _generate_code_path(module: str | None) -> str:
    q: dict[str, str] = {"artifact": "unit", "mode": "module"}
    if module:
        q["module"] = module
    return "/unit-test?" + urlencode(q)


def resolve_next_action(
    *,
    spec_status: str,
    tc_total: int,
    tc_approved: int,
    tc_draft: int,
    code_status: str,
    run_status: str,
    requirement_ids: list[str],
    display_name: str,
    has_local_path: bool,
    add_function: bool = False,
) -> tuple[str, str, str]:
    """Returns (action, label, path) — F0.3 CTA priority."""
    primary_req = requirement_ids[0] if requirement_ids else None
    mod = None if display_name == UNMODULED else display_name

    if add_function and primary_req:
        return (
            "create_spec",
            "Thêm chức năng",
            f"/spec?requirementId={primary_req}",
        )
    if spec_status == "missing":
        return "create_spec", "Tạo yêu cầu", "/requirement?tab=edit"
    if tc_total == 0:
        return "generate_tc", "Sinh TC", _generate_tc_path(primary_req, mod)
    if tc_draft > 0:
        q = {"tab": "review"}
        if mod:
            q["module"] = mod
        return "review_tc", "Duyệt TC", "/requirement?" + urlencode(q)
    if tc_approved >= 1 and code_status != "applied":
        if not has_local_path:
            return "generate_code", "Mở Workspace", "/workspace"
        return "generate_code", "Unit test", _generate_code_path(mod)
    if code_status == "applied" and run_status in ("none", "failing"):
        return "run_tests", "Chạy test", "/run"
    if code_status == "applied" and run_status == "passing":
        return "reports", "Xem báo cáo", "/reports"
    return "none", "—", "/requirement"


class _FnBucket:
    __slots__ = (
        "display_name",
        "from_topic",
        "tc_total",
        "tc_approved",
        "tc_draft",
        "code_applied",
        "code_staged",
        "code_verified",
    )

    def __init__(self, display_name: str, *, from_topic: bool = False) -> None:
        self.display_name = display_name
        self.from_topic = from_topic
        self.tc_total = 0
        self.tc_approved = 0
        self.tc_draft = 0
        self.code_applied = 0
        self.code_staged = 0
        self.code_verified = 0


def _ensure_fn(
    buckets: dict[str, _FnBucket], display: str, *, from_topic: bool = False
) -> _FnBucket:
    mk = _merge_key(display)
    b = buckets.get(mk)
    if b is None:
        b = _FnBucket(display, from_topic=from_topic)
        buckets[mk] = b
    else:
        if from_topic:
            b.from_topic = True
        if b.display_name == UNMODULED and display != UNMODULED:
            b.display_name = display
    return b


def _build_function_row(
    *,
    req_id: str,
    b: _FnBucket,
    run_status: str,
    run_pass: int,
    run_fail: int,
    has_local_path: bool,
) -> dict[str, Any]:
    tcs = _tc_status(b.tc_total, b.tc_approved, b.tc_draft)
    code_final = _code_status(
        b.tc_approved, b.code_applied, b.code_staged, b.code_verified
    )
    action, label, path = resolve_next_action(
        spec_status="ready" if (b.from_topic or req_id) else "missing",
        tc_total=b.tc_total,
        tc_approved=b.tc_approved,
        tc_draft=b.tc_draft,
        code_status=code_final,
        run_status=run_status,
        requirement_ids=[req_id] if req_id else [],
        display_name=b.display_name,
        has_local_path=has_local_path,
    )
    return {
        "key": f"{req_id}::{_merge_key(b.display_name)}" if req_id else f"orphan::{_merge_key(b.display_name)}",
        "displayName": b.display_name,
        "functionName": b.display_name,
        "rowKind": "function",
        "specStatus": "ready" if (b.from_topic or b.tc_total > 0) else "missing",
        "requirementIds": [req_id] if req_id else [],
        "requirementId": req_id or None,
        "tcTotal": b.tc_total,
        "tcApproved": b.tc_approved,
        "tcDraft": b.tc_draft,
        "tcStatus": tcs,
        "codeApplied": b.code_applied,
        "codeStaged": b.code_staged + b.code_verified,
        "codeStatus": code_final,
        "runPass": run_pass,
        "runFail": run_fail,
        "runStatus": run_status,
        "nextAction": action,
        "nextLabel": label,
        "nextPath": path,
    }


def compute_coverage_board(
    db: Session,
    project_id: uuid.UUID,
    *,
    has_local_path: bool = False,
    page: int = 1,
    page_size: int = 50,
    module_q: str | None = None,
) -> dict[str, Any] | None:
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return None

    if page < 1:
        page = 1
    if page_size < 1:
        page_size = 50
    if page_size > 100:
        page_size = 100

    sources = (
        db.query(Source)
        .filter(Source.project_id == project_id, Source.deleted_at.is_(None))
        .order_by(Source.title.asc())
        .all()
    )
    requirement_count = len(sources)

    topic_rows = (
        db.query(RequirementTopic)
        .filter(
            RequirementTopic.project_id == project_id,
            RequirementTopic.deleted_at.is_(None),
        )
        .all()
    )
    topics_by_source: dict[uuid.UUID, list[str]] = defaultdict(list)
    for tr in topic_rows:
        title = (tr.title or "").strip()
        if title:
            topics_by_source[tr.source_id].append(title)

    by_req: dict[str, dict[str, _FnBucket]] = {}
    req_titles: dict[str, str] = {}

    for src in sources:
        sid = str(src.id)
        req_titles[sid] = (src.title or "").strip() or sid[:8]
        buckets: dict[str, _FnBucket] = {}
        titles = list(topics_by_source.get(src.id) or [])
        if not titles:
            titles = [
                str(t.get("title") or "").strip()
                for t in topics_from_description(src.description)
                if str(t.get("title") or "").strip()
            ]
        for title in titles:
            _ensure_fn(buckets, _norm_display(title), from_topic=True)
        by_req[sid] = buckets

    mod_display = func.coalesce(
        func.nullif(func.trim(TestCase.module), ""), UNMODULED
    )
    mod_key = func.lower(mod_display)
    approved_sum = func.sum(
        case((TestCase.review_status == "Approved", 1), else_=0)
    )
    draft_sum = func.sum(
        case(
            (TestCase.review_status.in_(("Draft", "InReview")), 1),
            else_=0,
        )
    )
    tc_rows = (
        db.query(
            TestCase.source_id.label("source_id"),
            mod_key.label("mk"),
            func.min(mod_display).label("display"),
            func.count().label("total"),
            approved_sum.label("approved"),
            draft_sum.label("draft"),
        )
        .filter(TestCase.project_id == project_id, TestCase.deleted_at.is_(None))
        .group_by(TestCase.source_id, mod_key)
        .all()
    )

    tc_total_all = 0
    tc_approved_all = 0
    pending_count = 0
    orphan_fn: dict[str, _FnBucket] = {}

    for row in tc_rows:
        total = int(row.total or 0)
        approved = int(row.approved or 0)
        draft = int(row.draft or 0)
        tc_total_all += total
        tc_approved_all += approved
        pending_count += draft
        display = _norm_display(row.display)
        sid = str(row.source_id) if row.source_id else None
        if sid and sid in by_req:
            b = _ensure_fn(by_req[sid], display)
            b.tc_total += total
            b.tc_approved += approved
            b.tc_draft += draft
        else:
            b = _ensure_fn(orphan_fn, display)
            b.tc_total += total
            b.tc_approved += approved
            b.tc_draft += draft

    run_mod = func.coalesce(
        func.nullif(func.trim(WorkspaceRun.module), ""), UNMODULED
    )
    run_key = func.lower(run_mod)
    ws_rows = (
        db.query(
            run_key.label("mk"),
            func.min(run_mod).label("display"),
            WorkspaceRun.status,
            func.count().label("cnt"),
        )
        .filter(
            WorkspaceRun.project_id == project_id,
            WorkspaceRun.deleted_at.is_(None),
        )
        .group_by(run_key, WorkspaceRun.status)
        .all()
    )
    code_by_fn: dict[str, dict[str, int]] = defaultdict(
        lambda: {"applied": 0, "staged": 0, "verified": 0}
    )
    for row in ws_rows:
        mk = row.mk or _merge_key(UNMODULED)
        st = (row.status or "").lower()
        cnt = int(row.cnt or 0)
        if st == "applied":
            code_by_fn[mk]["applied"] += cnt
        elif st in ("pass", "verified"):
            code_by_fn[mk]["verified"] += cnt
        elif st in ("generated", "ok", "running", "draft"):
            code_by_fn[mk]["staged"] += cnt

    for buckets in list(by_req.values()) + ([orphan_fn] if orphan_fn else []):
        for mk, b in buckets.items():
            c = code_by_fn.get(mk)
            if not c:
                continue
            b.code_applied += c["applied"]
            b.code_staged += c["staged"]
            b.code_verified += c["verified"]

    execs = (
        db.query(Execution)
        .filter(Execution.project_id == project_id, Execution.deleted_at.is_(None))
        .order_by(Execution.started_at.desc())
        .limit(50)
        .all()
    )
    run_status = _project_run_status(execs)
    run_pass = sum(1 for e in execs if "pass" in (e.status or "").lower())
    run_fail = sum(
        1
        for e in execs
        if any(x in (e.status or "").lower() for x in ("fail", "error"))
    )

    requirements_out: list[dict[str, Any]] = []
    modules_flat: list[dict[str, Any]] = []
    qn = (module_q or "").strip().lower()

    for sid, buckets in by_req.items():
        title = req_titles[sid]
        if qn and qn not in title.lower() and not any(
            qn in b.display_name.lower() for b in buckets.values()
        ):
            continue

        fn_rows: list[dict[str, Any]] = []
        for b in sorted(
            buckets.values(),
            key=lambda x: (
                1 if x.display_name == UNMODULED else 0,
                x.display_name.lower(),
            ),
        ):
            if qn and qn not in b.display_name.lower() and qn not in title.lower():
                continue
            row = _build_function_row(
                req_id=sid,
                b=b,
                run_status=run_status,
                run_pass=run_pass,
                run_fail=run_fail,
                has_local_path=has_local_path,
            )
            fn_rows.append(row)
            modules_flat.append(row)

        if not buckets:
            action, label, path = resolve_next_action(
                spec_status="ready",
                tc_total=0,
                tc_approved=0,
                tc_draft=0,
                code_status="none",
                run_status=run_status,
                requirement_ids=[sid],
                display_name=UNMODULED,
                has_local_path=has_local_path,
                add_function=True,
            )
            placeholder = {
                "key": f"{sid}::placeholder",
                "displayName": "— chưa có chức năng —",
                "functionName": "",
                "rowKind": "function",
                "specStatus": "missing",
                "requirementIds": [sid],
                "requirementId": sid,
                "tcTotal": 0,
                "tcApproved": 0,
                "tcDraft": 0,
                "tcStatus": "none",
                "codeApplied": 0,
                "codeStaged": 0,
                "codeStatus": "none",
                "runPass": run_pass,
                "runFail": run_fail,
                "runStatus": run_status,
                "nextAction": action,
                "nextLabel": label,
                "nextPath": path,
            }
            fn_rows = [placeholder]
            modules_flat.append(placeholder)

        tc_t = sum(r["tcTotal"] for r in fn_rows)
        tc_a = sum(r["tcApproved"] for r in fn_rows)
        tc_d = sum(r["tcDraft"] for r in fn_rows)
        gap_child = next(
            (r for r in fn_rows if r["nextAction"] not in ("none", "reports")),
            None,
        )
        requirements_out.append(
            {
                "id": sid,
                "title": title,
                "key": f"req::{sid}",
                "rowKind": "requirement",
                "displayName": title,
                "functionCount": len([r for r in fn_rows if r.get("functionName")]),
                "tcTotal": tc_t,
                "tcApproved": tc_a,
                "tcDraft": tc_d,
                "tcStatus": _tc_status(tc_t, tc_a, tc_d),
                "specStatus": "ready",
                "requirementIds": [sid],
                "codeStatus": gap_child["codeStatus"] if gap_child else "none",
                "codeApplied": sum(r["codeApplied"] for r in fn_rows),
                "codeStaged": sum(r["codeStaged"] for r in fn_rows),
                "runStatus": run_status,
                "runPass": run_pass,
                "runFail": run_fail,
                "nextAction": gap_child["nextAction"] if gap_child else "none",
                "nextLabel": gap_child["nextLabel"] if gap_child else "—",
                "nextPath": gap_child["nextPath"] if gap_child else "/requirement",
                "functions": fn_rows,
                "children": fn_rows,
            }
        )

    if orphan_fn:
        fn_rows = []
        for b in orphan_fn.values():
            row = _build_function_row(
                req_id="",
                b=b,
                run_status=run_status,
                run_pass=run_pass,
                run_fail=run_fail,
                has_local_path=has_local_path,
            )
            action, label, path = resolve_next_action(
                spec_status="missing",
                tc_total=b.tc_total,
                tc_approved=b.tc_approved,
                tc_draft=b.tc_draft,
                code_status=row["codeStatus"],
                run_status=run_status,
                requirement_ids=[],
                display_name=b.display_name,
                has_local_path=has_local_path,
            )
            row["nextAction"] = action
            row["nextLabel"] = label
            row["nextPath"] = path
            fn_rows.append(row)
            modules_flat.append(row)
        requirements_out.append(
            {
                "id": "",
                "title": "(TC chưa gắn yêu cầu)",
                "key": "req::orphan",
                "rowKind": "requirement",
                "displayName": "(TC chưa gắn yêu cầu)",
                "functionCount": len(fn_rows),
                "tcTotal": sum(r["tcTotal"] for r in fn_rows),
                "tcApproved": sum(r["tcApproved"] for r in fn_rows),
                "tcDraft": sum(r["tcDraft"] for r in fn_rows),
                "tcStatus": "partial",
                "specStatus": "missing",
                "requirementIds": [],
                "codeStatus": "none",
                "codeApplied": 0,
                "codeStaged": 0,
                "runStatus": run_status,
                "runPass": run_pass,
                "runFail": run_fail,
                "nextAction": "create_spec",
                "nextLabel": "Tạo yêu cầu",
                "nextPath": "/requirement?tab=edit",
                "functions": fn_rows,
                "children": fn_rows,
            }
        )

    total_req = len(requirements_out)
    start = (page - 1) * page_size
    page_reqs = requirements_out[start : start + page_size]
    page_modules = [fn for req in page_reqs for fn in (req.get("functions") or [])]

    gap_count = sum(
        1 for m in modules_flat if m["nextAction"] not in ("none", "reports")
    )
    ready_modules = sum(
        1 for m in modules_flat if m["nextAction"] in ("none", "reports")
    )

    has_tc_gap = any(
        m["specStatus"] == "ready" and m["tcTotal"] == 0 and m.get("functionName")
        for m in modules_flat
    )
    has_code_gap = any(
        m["tcApproved"] >= 1 and m["codeStatus"] != "applied" for m in modules_flat
    )
    next_project: dict[str, str] | None = None
    if has_tc_gap:
        next_project = {
            "action": "generate_tc_gaps",
            "label": "Sinh TC còn thiếu — cả dự án",
            "path": "/requirement",
        }
    elif has_code_gap:
        next_project = {
            "action": "generate_code_gaps",
            "label": "Unit test còn thiếu — cả dự án",
            "path": "/requirement",
        }

    return {
        "projectId": str(project_id),
        "requirements": page_reqs,
        "modules": page_modules,
        "pageNumber": page,
        "pageSize": page_size,
        "totalModules": len(modules_flat),
        "totalRequirements": total_req,
        "hasPrevious": page > 1,
        "hasNext": start + page_size < total_req,
        "totals": {
            "moduleCount": len(modules_flat),
            "gapCount": gap_count,
            "requirementCount": requirement_count,
            "tcTotal": tc_total_all,
            "tcApproved": tc_approved_all,
            "modules": len(modules_flat),
            "gaps": gap_count,
            "readyModules": ready_modules,
            "functionCount": len(modules_flat),
        },
        "projectRunStatus": run_status,
        "pendingCount": pending_count,
        "nextProjectAction": next_project,
    }
