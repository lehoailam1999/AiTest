from __future__ import annotations

import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Request, UploadFile
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.domain import (
    GenerationTask,
    Job,
    RequirementTopic,
    Source,
    TestCase,
    WorkspaceRun,
)
from app.responses import errors, ok, page, page_params
from app.serializers import (
    requirement_detail_dto,
    requirement_dto,
    source_dto,
)
from app.services.requirement_content import (
    SECTION_FEATURE,
    SECTION_NOTES,
    SECTION_SRS,
    SECTION_USER_STORY,
    build_content,
    encode_requirement_meta,
    enrich_features_with_files,
    expand_sources,
    parse_features,
    parse_sections,
    sources_for_detail,
)
from app.services.requirement_topics import (
    merge_topics_into_description,
    sync_topics_from_features,
    topics_from_description,
)

router = APIRouter(prefix="/api", tags=["sources"], dependencies=[Depends(get_current_user)])


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


# --- Sources ---


@router.post("/projects/{project_id}/sources")
async def create_source(
    project_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    pid = _uuid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    body = await request.json()
    title = (body.get("title") or "").strip()
    content = (body.get("content") or "").strip()
    if not title or not content:
        return errors(400, "title and content required")
    src = Source(
        project_id=pid,
        source_type=body.get("sourceType") or "Requirement",
        title=title,
        content=body.get("content"),
        file_name=body.get("fileName"),
        description=body.get("description"),
    )
    db.add(src)
    db.commit()
    db.refresh(src)
    return ok(source_dto(src))


@router.get("/projects/{project_id}/sources")
def list_sources(project_id: str, request: Request, db: Annotated[Session, Depends(get_db)]):
    pid = _uuid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    q = db.query(Source).filter(Source.project_id == pid, Source.deleted_at.is_(None))
    total = q.count()
    items = (
        q.order_by(Source.created_at.desc())
        .offset((page_number - 1) * size)
        .limit(size)
        .all()
    )
    return ok(page([source_dto(s) for s in items], total, page_number, size))


@router.get("/sources/{source_id}")
def get_source(source_id: str, db: Annotated[Session, Depends(get_db)]):
    sid = _uuid(source_id)
    if sid is None:
        return errors(400, "invalid id")
    src = db.query(Source).filter(Source.id == sid, Source.deleted_at.is_(None)).first()
    if src is None:
        return errors(404, "not found")
    return ok(source_dto(src))


@router.delete("/sources/{source_id}")
def delete_source(source_id: str, db: Annotated[Session, Depends(get_db)]):
    """Hard-delete requirement + topics + linked test cases."""
    return _hard_delete_requirement(source_id, db)


@router.delete("/requirements/{req_id}")
def delete_requirement(req_id: str, db: Annotated[Session, Depends(get_db)]):
    """Hard-delete requirement + topics + linked test cases."""
    return _hard_delete_requirement(req_id, db)


def _hard_delete_requirement(req_id: str, db: Session):
    sid = _uuid(req_id)
    if sid is None:
        return errors(400, "invalid id")
    src = db.query(Source).filter(Source.id == sid).first()
    if src is None:
        return errors(404, "not found")

    # TCs gắn trực tiếp + TCs sinh từ job của requirement này
    job_ids = [
        row.id for row in db.query(Job.id).filter(Job.source_id == sid).all()
    ]
    tc_q = db.query(TestCase.id).filter(TestCase.source_id == sid)
    if job_ids:
        tc_q = db.query(TestCase.id).filter(
            (TestCase.source_id == sid) | (TestCase.job_id.in_(job_ids))
        )
    tc_ids = [row.id for row in tc_q.all()]

    deleted_tc = 0
    if tc_ids:
        db.query(GenerationTask).filter(GenerationTask.test_case_id.in_(tc_ids)).delete(
            synchronize_session=False
        )
        db.query(WorkspaceRun).filter(WorkspaceRun.test_case_id.in_(tc_ids)).update(
            {WorkspaceRun.test_case_id: None},
            synchronize_session=False,
        )
        deleted_tc = (
            db.query(TestCase)
            .filter(TestCase.id.in_(tc_ids))
            .delete(synchronize_session=False)
        )

    deleted_topics = (
        db.query(RequirementTopic)
        .filter(RequirementTopic.source_id == sid)
        .delete(synchronize_session=False)
    )

    if job_ids:
        db.query(Job).filter(Job.id.in_(job_ids)).update(
            {Job.source_id: None},
            synchronize_session=False,
        )
    else:
        db.query(Job).filter(Job.source_id == sid).update(
            {Job.source_id: None},
            synchronize_session=False,
        )

    db.delete(src)
    db.commit()
    return ok(
        {
            "status": "ok",
            "deletedTestCases": int(deleted_tc or 0),
            "deletedTopics": int(deleted_topics or 0),
        }
    )


# --- Requirements (compat → Source) ---


@router.get("/requirements")
def list_requirements(request: Request, db: Annotated[Session, Depends(get_db)]):
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    q = db.query(Source).filter(Source.deleted_at.is_(None))
    project_q = request.query_params.get("projectId")
    if project_q:
        pid = _uuid(project_q)
        if pid is not None:
            q = q.filter(Source.project_id == pid)
    total = q.count()
    items = (
        q.order_by(Source.created_at.desc())
        .offset((page_number - 1) * size)
        .limit(size)
        .all()
    )
    return ok(page([requirement_dto(s) for s in items], total, page_number, size))


def _content_from_body(
    body: dict, *, old_content: str | None = None
) -> tuple[str, str, str | None, list[dict]]:
    content = (body.get("content") or "").strip()
    source_type = body.get("inputType") or "Requirement"
    file_name = None
    sources = body.get("sources") or []
    clear_documents = bool(body.get("clearDocuments"))

    def _is_doc_source(st: str) -> bool:
        s = (st or "").strip()
        return s in (SECTION_FEATURE, SECTION_SRS, SECTION_USER_STORY) or s.lower() == "feature"

    file_sources = [s for s in sources if _is_doc_source(str(s.get("sourceType") or ""))]

    # Sửa requirement nhưng FE không gửi lại file → giữ Feature/SRS cũ (trừ khi clearDocuments)
    if (
        not file_sources
        and not clear_documents
        and old_content
        and (
            parse_features(old_content)
            or any(
                (parse_sections(old_content).get(k) or "").strip()
                for k in (SECTION_SRS, SECTION_USER_STORY)
            )
        )
    ):
        preserved = [
            s
            for s in sources_for_detail(old_content, None)
            if _is_doc_source(str(s.get("sourceType") or ""))
        ]
        sources = [*preserved, *[s for s in sources if not _is_doc_source(str(s.get("sourceType") or ""))]]

    if sources:
        normalized: list[dict] = []
        for s in sources:
            st = (s.get("sourceType") or "").strip()
            text = (s.get("content") or "").strip()
            if not text:
                continue
            preview = s.get("previewHtml")
            if isinstance(preview, str) and len(preview) > 80_000:
                preview = None
            row: dict = {
                "sourceType": st,
                "content": text,
                "fileName": s.get("fileName"),
                "previewHtml": preview,
            }
            if s.get("title"):
                row["title"] = s.get("title")
            normalized.append(row)
            if s.get("fileName") and file_name is None:
                file_name = s["fileName"]
        if content:
            # Tránh nhân đôi khối Requirement
            normalized = [s for s in normalized if s.get("sourceType") != SECTION_NOTES]
            normalized.append(
                {"sourceType": SECTION_NOTES, "content": content, "fileName": None}
            )
        normalized = expand_sources(normalized)
        content = build_content(normalized)
        sources = normalized
        names = [str(s.get("fileName") or "") for s in normalized if s.get("fileName")]
        if names:
            joined = ", ".join(names[:12])
            file_name = joined[:500]
        if any(s["sourceType"] == SECTION_FEATURE for s in normalized):
            source_type = SECTION_FEATURE
        elif any(s["sourceType"] == SECTION_USER_STORY for s in normalized):
            source_type = SECTION_USER_STORY
        elif any(s["sourceType"] == SECTION_SRS for s in normalized):
            source_type = SECTION_SRS
    elif content:
        sources = [{"sourceType": SECTION_NOTES, "content": content, "fileName": None}]

    return content, source_type, file_name, sources


def _require_requirement_section(content: str) -> str | None:
    sections = parse_sections(content)
    if not (sections.get(SECTION_NOTES) or "").strip():
        return "Yêu cầu (Requirement) là bắt buộc — mô tả phạm vi để AI sinh test case"
    return None


def _mirror_requirement_topics(db: Session, src: Source) -> None:
    """Keep requirement_topics table in sync with JSON topics meta."""
    topics = topics_from_description(src.description)
    db.query(RequirementTopic).filter(RequirementTopic.source_id == src.id).delete(
        synchronize_session=False
    )
    for i, t in enumerate(topics):
        tid = _uuid(str(t.get("id") or "")) or uuid.uuid4()
        db.add(
            RequirementTopic(
                id=tid,
                source_id=src.id,
                project_id=src.project_id,
                title=str(t.get("title") or "")[:300],
                sort_order=i,
                items_json=json.dumps(t.get("items") or [], ensure_ascii=False),
            )
        )


def _apply_feature_topics(src: Source, content: str) -> None:
    """Auto-create chức năng (topics) from ### Feature blocks / multi-file docs."""
    features = enrich_features_with_files(parse_features(content or ""), src.description)
    if not features:
        return
    src.description = sync_topics_from_features(src.description, features)


@router.post("/requirements")
async def create_requirement(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    pid = _uuid(str(body.get("projectId") or ""))
    title = (body.get("title") or "").strip()
    if pid is None or not title:
        return errors(400, "projectId and title required")
    try:
        content, source_type, file_name, sources = _content_from_body(body)
        req_err = _require_requirement_section(content)
        if req_err:
            return errors(400, req_err)
        src = Source(
            project_id=pid,
            source_type=source_type,
            title=title,
            content=content,
            file_name=file_name,
            description=encode_requirement_meta(content, sources, body.get("description"), None),
        )
        _apply_feature_topics(src, content)
        db.add(src)
        db.flush()
        _mirror_requirement_topics(db, src)
        db.commit()
        db.refresh(src)
        return ok(requirement_dto(src))
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        return errors(400, f"Không lưu được requirement: {exc}")


@router.get("/requirements/{req_id}")
def get_requirement(req_id: str, db: Annotated[Session, Depends(get_db)]):
    sid = _uuid(req_id)
    if sid is None:
        return errors(400, "invalid id")
    src = db.query(Source).filter(Source.id == sid, Source.deleted_at.is_(None)).first()
    if src is None:
        return errors(404, "not found")
    return ok(requirement_detail_dto(src))


@router.put("/requirements/{req_id}")
async def update_requirement(
    req_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    sid = _uuid(req_id)
    if sid is None:
        return errors(400, "invalid id")
    src = db.query(Source).filter(Source.id == sid, Source.deleted_at.is_(None)).first()
    if src is None:
        return errors(404, "not found")
    body = await request.json()
    try:
        if body.get("title"):
            src.title = body["title"]
        old_description = src.description
        old_content = src.content
        if body.get("content") is not None or body.get("sources") is not None:
            content, source_type, file_name, sources = _content_from_body(
                body, old_content=old_content
            )
            req_err = _require_requirement_section(content)
            if req_err:
                return errors(400, req_err)
            src.content = content
            src.source_type = source_type
            if file_name:
                src.file_name = file_name
            src.description = encode_requirement_meta(
                content,
                sources,
                body.get("description"),
                old_description,
                old_content=old_content,
                change_summary=body.get("changeSummary"),
            )
            _apply_feature_topics(src, content)
            _mirror_requirement_topics(db, src)
        elif body.get("description") is not None:
            src.description = encode_requirement_meta(
                src.content, [], body.get("description"), old_description
            )
        db.commit()
        db.refresh(src)
        return ok(requirement_dto(src))
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        return errors(400, f"Không cập nhật được requirement: {exc}")


@router.get("/requirements/{req_id}/topics")
def get_requirement_topics(req_id: str, db: Annotated[Session, Depends(get_db)]):
    sid = _uuid(req_id)
    if sid is None:
        return errors(400, "invalid id")
    src = db.query(Source).filter(Source.id == sid, Source.deleted_at.is_(None)).first()
    if src is None:
        return errors(404, "not found")
    # Backfill: tài liệu cũ gộp nhiều file → tự tạo chức năng từ Feature / --- markers
    before = topics_from_description(src.description)
    _apply_feature_topics(src, src.content or "")
    after = topics_from_description(src.description)
    if len(after) > len(before):
        _mirror_requirement_topics(db, src)
        db.commit()
        db.refresh(src)
    return ok({"topics": topics_from_description(src.description)})


@router.put("/requirements/{req_id}/topics")
async def put_requirement_topics(
    req_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    sid = _uuid(req_id)
    if sid is None:
        return errors(400, "invalid id")
    src = db.query(Source).filter(Source.id == sid, Source.deleted_at.is_(None)).first()
    if src is None:
        return errors(404, "not found")
    body = await request.json()
    raw = body.get("topics")
    if not isinstance(raw, list):
        return errors(400, "topics must be an array")
    normalized = topics_from_description(json.dumps({"topics": raw}))
    src.description = merge_topics_into_description(src.description, normalized)
    _mirror_requirement_topics(db, src)
    db.commit()
    db.refresh(src)
    return ok({"topics": topics_from_description(src.description)})


@router.post("/requirements/parse-file")
async def parse_file(file: Annotated[UploadFile, File()]):
    from app.services.requirement_file_parse import parse_requirement_file

    raw = await file.read()
    if len(raw) > 15_000_000:
        return errors(400, "File quá lớn (tối đa ~15 MB)")
    name = file.filename or "upload"
    try:
        parsed = parse_requirement_file(raw, name)
    except ValueError as e:
        return errors(400, str(e))

    return ok(
        {
            "fileName": name,
            "text": parsed.text,
            "html": parsed.html,
            "parser": parsed.parser,
            "warning": parsed.warning,
            "charCount": len(parsed.text),
        }
    )
