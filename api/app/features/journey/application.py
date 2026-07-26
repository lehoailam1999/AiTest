from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.models.domain import AiBackendConnection, Project, Source, TestCase


def _normalize_fs_root(path: str | None) -> str:
    if not path:
        return ""
    p = path.replace("\\", "/").replace("//", "/")
    while "//" in p:
        p = p.replace("//", "/")
    return p.rstrip("/").lower()


def roots_aligned(ide_root: str | None, local_path: str | None) -> bool | None:
    """None when either path missing; else True if same or nested."""
    a = _normalize_fs_root(local_path)
    b = _normalize_fs_root(ide_root)
    if not a or not b:
        return None
    return a == b or a.startswith(f"{b}/") or b.startswith(f"{a}/")


def compute_journey_payload(
    db: Session,
    project_id: uuid.UUID,
    *,
    ide_root: str | None = None,
    local_path: str | None = None,
) -> dict | None:
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return None

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    ai_ready = bool(conn and conn.status in ("Ready", "Connected"))

    req_count = (
        db.query(Source)
        .filter(Source.project_id == project_id, Source.deleted_at.is_(None))
        .count()
    )
    tcs = (
        db.query(TestCase)
        .filter(TestCase.project_id == project_id, TestCase.deleted_at.is_(None))
        .all()
    )
    total = len(tcs)
    draft = sum(1 for t in tcs if t.review_status in ("Draft", "InReview"))
    approved = sum(1 for t in tcs if t.review_status == "Approved")

    aligned = roots_aligned(ide_root, local_path)

    # Server cannot know local ProjectPath — FE merges hasLocalPath.
    if not ai_ready:
        next_step, next_label, next_path = "prepare", "Cấu hình AI", "/settings/ai"
    elif req_count == 0:
        next_step, next_label, next_path = "spec", "Tạo requirement", "/spec"
    elif total == 0:
        next_step, next_label, next_path = "gen-tc", "Sinh test case", "/generate/tc"
    elif approved == 0:
        next_step, next_label, next_path = "review", "Duyệt test case", "/spec"
    elif aligned is False:
        next_step, next_label, next_path = (
            "code",
            "Khớp thư mục IDE · Root",
            "/unit-test",
        )
    else:
        # Soft gate to Workspace Host when FE has no local path (merged client-side).
        next_step, next_label, next_path = "code", "Mở Workspace / Sinh mã", "/workspace"

    return {
        "projectId": str(project_id),
        "projectName": project.name,
        "aiReady": ai_ready,
        "requirementCount": req_count,
        "testCaseTotal": total,
        "draftCount": draft,
        "approvedCount": approved,
        "specDone": req_count > 0,
        "genTcDone": total > 0,
        "reviewDone": approved > 0,
        "currentStep": next_step,
        "nextStep": next_step,
        "nextLabel": next_label,
        "nextPath": next_path,
        "rootsAligned": aligned,
    }
