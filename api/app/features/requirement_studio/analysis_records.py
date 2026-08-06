"""12 analysis record types persisted from Knowledge payload."""

from __future__ import annotations

import json
import uuid

from sqlalchemy.orm import Session

from app.models.domain import RequirementAnalysisRecord

ANALYSIS_RECORD_TYPES: tuple[str, ...] = (
    "SUMMARY_SCOPE",
    "FEATURES",
    "ACTORS_PERMISSIONS",
    "BUSINESS_FLOWS",
    "EXECUTION_CONTEXT",
    "BUSINESS_RULES",
    "VALIDATION_DATA",
    "API_UI",
    "ERROR_HANDLING",
    "ACCEPTANCE",
    "NFR_CONSTRAINTS",
    "GAPS",
)


def _analysis_count(value: object) -> int:
    if isinstance(value, list):
        return len(value)
    if isinstance(value, str):
        return 1 if value.strip() else 0
    return 0


def analysis_records_from_payload(payload: dict | None) -> list[dict]:
    data = payload if isinstance(payload, dict) else {}
    return [
        {
            "type": "SUMMARY_SCOPE",
            "title": "Tóm tắt & phạm vi",
            "itemCount": _analysis_count(data.get("summary")),
            "content": {"summary": data.get("summary") or ""},
        },
        {
            "type": "FEATURES",
            "title": "Chức năng",
            "itemCount": _analysis_count(data.get("features")),
            "content": data.get("features") or [],
        },
        {
            "type": "ACTORS_PERMISSIONS",
            "title": "Actors & quyền",
            "itemCount": _analysis_count(data.get("actors")),
            "content": data.get("actors") or [],
        },
        {
            "type": "BUSINESS_FLOWS",
            "title": "Luồng nghiệp vụ",
            "itemCount": _analysis_count(data.get("useCases")),
            "content": data.get("useCases") or [],
        },
        {
            "type": "EXECUTION_CONTEXT",
            "title": "Execution Context",
            "itemCount": _analysis_count(data.get("executionContexts")),
            "content": data.get("executionContexts") or [],
        },
        {
            "type": "BUSINESS_RULES",
            "title": "Business rules",
            "itemCount": _analysis_count(data.get("businessRules")),
            "content": data.get("businessRules") or [],
        },
        {
            "type": "VALIDATION_DATA",
            "title": "Validation & dữ liệu",
            "itemCount": _analysis_count(data.get("validationRules")),
            "content": data.get("validationRules") or [],
        },
        {
            "type": "API_UI",
            "title": "API / giao diện",
            "itemCount": _analysis_count(data.get("apiSummary")),
            "content": data.get("apiSummary") or [],
        },
        {
            "type": "ERROR_HANDLING",
            "title": "Xử lý lỗi",
            "itemCount": _analysis_count(data.get("exceptions")),
            "content": data.get("exceptions") or [],
        },
        {
            "type": "ACCEPTANCE",
            "title": "Acceptance",
            "itemCount": _analysis_count(data.get("acceptanceCriteria")),
            "content": data.get("acceptanceCriteria") or [],
        },
        {
            "type": "NFR_CONSTRAINTS",
            "title": "Ràng buộc NFR",
            "itemCount": _analysis_count(data.get("constraints")),
            "content": data.get("constraints") or [],
        },
        {
            "type": "GAPS",
            "title": "Thiếu sót",
            "itemCount": _analysis_count(data.get("gaps")),
            "content": data.get("gaps") or [],
        },
    ]


def replace_analysis_records(
    db: Session,
    *,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    knowledge_id: uuid.UUID | None,
    knowledge_version: int,
    payload: dict | None,
) -> None:
    db.query(RequirementAnalysisRecord).filter(
        RequirementAnalysisRecord.workspace_id == workspace_id
    ).delete(synchronize_session=False)
    for row in analysis_records_from_payload(payload):
        db.add(
            RequirementAnalysisRecord(
                workspace_id=workspace_id,
                project_id=project_id,
                knowledge_id=knowledge_id,
                knowledge_version=int(knowledge_version or 0),
                type=row["type"],
                title=row["title"],
                item_count=int(row["itemCount"] or 0),
                content_json=json.dumps(row["content"], ensure_ascii=False),
            )
        )
