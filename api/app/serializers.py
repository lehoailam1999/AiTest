from __future__ import annotations

from app.models.domain import (
    AiBackendConnection,
    ApplyAudit,
    Execution,
    GenerationCampaign,
    GenerationTask,
    Job,
    Project,
    Source,
    TestCase,
    VerifyReportRecord,
    WorkspaceRun,
)
from app.services.requirement_content import (
    SECTION_SRS,
    SECTION_USER_STORY,
    change_summary_from_description,
    content_meta_from_description,
    parse_features,
    parse_sections,
    source_content_hash,
    sources_for_detail,
)
from app.services.requirement_topics import topics_from_description
from app.services.vietnamese_labels import priority_vi, severity_vi, type_vi


def _iso(dt):
    return dt.isoformat() if dt else None


def source_dto(s: Source) -> dict:
    return {
        "id": str(s.id),
        "projectId": str(s.project_id),
        "sourceType": s.source_type,
        "title": s.title,
        "content": s.content,
        "fileName": s.file_name,
        "description": s.description,
        "createdAt": _iso(s.created_at),
        "updatedAt": _iso(s.updated_at),
    }


def requirement_dto(s: Source) -> dict:
    sections = parse_sections(s.content or "")
    features = parse_features(s.content or "")
    content_hash, content_version = content_meta_from_description(s.description)
    return {
        "id": str(s.id),
        "projectId": str(s.project_id),
        "title": s.title,
        "description": s.description,
        "inputType": s.source_type,
        "status": "Ready",
        "version": content_version,
        "contentHash": content_hash,
        "contentVersion": content_version,
        "changeSummary": change_summary_from_description(s.description),
        "hasUserStory": SECTION_USER_STORY in sections,
        "hasSrs": SECTION_SRS in sections or bool(features),
        "featureCount": len(features),
        "fileName": s.file_name,
        "topics": topics_from_description(s.description),
        "createdAt": _iso(s.created_at),
        "updatedAt": _iso(s.updated_at),
    }


def requirement_detail_dto(s: Source) -> dict:
    dto = requirement_dto(s)
    dto["sources"] = sources_for_detail(s.content, s.description)
    return dto


def connection_dto(c: AiBackendConnection) -> dict:
    has_key = bool(c.api_key_ciphertext)
    return {
        "id": str(c.id),
        "projectId": str(c.project_id),
        "backendType": c.backend_type,
        "provider": c.backend_type,
        "modelName": c.model_name,
        "baseUrl": getattr(c, "base_url", None),
        "status": c.status,
        "hasApiKey": has_key,
        "lastVerifiedAt": _iso(c.last_verified_at),
        "lastError": c.last_error,
    }


def job_dto(j: Job) -> dict:
    return {
        "id": str(j.id),
        "projectId": str(j.project_id),
        "sourceId": str(j.source_id) if j.source_id else None,
        "requirementSnapshotId": str(j.requirement_snapshot_id)
        if getattr(j, "requirement_snapshot_id", None)
        else None,
        "status": j.status,
        "backendType": j.backend_type,
        "generateStrategy": j.generate_strategy,
        "requirementVersion": j.requirement_version,
        "error": j.error,
        "startedAt": _iso(j.started_at),
        "completedAt": _iso(j.completed_at),
        "createdAt": _iso(j.created_at),
        "updatedAt": _iso(j.updated_at),
    }


def testcase_dto(t: TestCase, source_content_hash: str | None = None) -> dict:
    gen_hash = t.generated_from_hash
    is_stale = bool(
        source_content_hash
        and t.is_ai_generated
        and (not gen_hash or gen_hash != source_content_hash)
    )
    return {
        "id": str(t.id),
        "projectId": str(t.project_id),
        "sourceId": str(t.source_id) if t.source_id else None,
        "requirementSnapshotId": str(t.requirement_snapshot_id)
        if getattr(t, "requirement_snapshot_id", None)
        else None,
        "jobId": str(t.job_id) if t.job_id else None,
        "testCaseId": t.test_case_code,
        "title": t.title,
        "module": t.module,
        "type": type_vi(t.type),
        "priority": priority_vi(t.priority),
        "severity": severity_vi(t.severity),
        "precondition": t.precondition,
        "steps": t.steps,
        "expectedResult": t.expected_result,
        "actualResult": t.actual_result,
        "testData": t.test_data,
        "automationReady": t.automation_ready,
        "isAiGenerated": t.is_ai_generated,
        "reviewStatus": t.review_status,
        "reviewedBy": str(t.reviewed_by) if t.reviewed_by else None,
        "reviewedAt": _iso(t.reviewed_at),
        "reviewComment": t.review_comment,
        "executionStatus": t.execution_status,
        "generatedFromHash": gen_hash,
        "generatedFromVersion": t.generated_from_version,
        "isStale": is_stale,
        "needsReview": is_stale,
        "createdAt": _iso(t.created_at),
        "updatedAt": _iso(t.updated_at),
    }


def project_dto(p: Project, requirement_count: int, testcase_count: int) -> dict:
    meta = None
    if p.meta:
        try:
            meta = __import__("json").loads(p.meta)
        except (TypeError, ValueError):
            meta = None
    return {
        "id": str(p.id),
        "name": p.name,
        "description": p.description,
        "code": p.code,
        "language": p.language,
        "framework": p.framework,
        "meta": meta,
        "isActive": p.is_active,
        "requirementCount": requirement_count,
        "testCaseCount": testcase_count,
        "createdAt": _iso(p.created_at),
    }


def execution_dto(e: Execution) -> dict:
    return {
        "id": str(e.id),
        "projectId": str(e.project_id),
        "command": e.command,
        "exitCode": e.exit_code,
        "status": e.status,
        "passed": e.passed,
        "failed": e.failed,
        "skipped": e.skipped,
        "total": e.total,
        "durationMs": e.duration_ms,
        "logExcerpt": e.log_excerpt,
        "trxFileName": e.trx_file_name,
        "filter": e.filter,
        "startedAt": _iso(e.started_at),
        "finishedAt": _iso(e.finished_at),
        "createdAt": _iso(e.created_at),
    }


def workspace_run_dto(r: WorkspaceRun) -> dict:
    return {
        "id": str(r.id),
        "projectId": str(r.project_id),
        "localRunId": r.local_run_id,
        "testType": r.test_type,
        "testCaseId": str(r.test_case_id) if r.test_case_id else None,
        "module": r.module,
        "status": r.status,
        "provider": r.provider,
        "contextSource": getattr(r, "context_source", None),
        "agentConfidence": getattr(r, "agent_confidence", None),
        "agentOverride": bool(getattr(r, "agent_override", False)),
        "startedAt": _iso(r.started_at),
        "finishedAt": _iso(r.finished_at),
        "createdAt": _iso(r.created_at),
    }


def generation_task_dto(t: GenerationTask) -> dict:
    return {
        "id": str(t.id),
        "campaignId": str(t.campaign_id),
        "testCaseId": str(t.test_case_id) if t.test_case_id else None,
        "localRunId": t.local_run_id,
        "status": t.status,
        "error": t.error,
        "sortOrder": t.sort_order,
        "createdAt": _iso(t.created_at),
    }


def campaign_dto(c: GenerationCampaign, tasks: list[GenerationTask]) -> dict:
    return {
        "id": str(c.id),
        "projectId": str(c.project_id),
        "kind": c.kind,
        "scopeLevel": c.scope_level,
        "scopeLabel": c.scope_label,
        "status": c.status,
        "startedAt": _iso(c.started_at),
        "finishedAt": _iso(c.finished_at),
        "tasks": [generation_task_dto(t) for t in tasks],
        "createdAt": _iso(c.created_at),
    }


def verify_report_dto(rec: VerifyReportRecord, run: WorkspaceRun) -> dict:
    return {
        "id": str(rec.id),
        "workspaceRunId": str(rec.workspace_run_id),
        "localRunId": run.local_run_id,
        "compileStatus": rec.compile_status,
        "testStatus": rec.test_status,
        "coverageStatus": rec.coverage_status,
        "overallPass": rec.overall_pass,
        "summaryJson": rec.summary_json,
        "createdAt": _iso(rec.created_at),
    }


def apply_audit_dto(rec: ApplyAudit, run: WorkspaceRun) -> dict:
    import json

    try:
        files = json.loads(rec.files_applied_json or "[]")
    except (TypeError, ValueError):
        files = []
    return {
        "id": str(rec.id),
        "workspaceRunId": str(rec.workspace_run_id),
        "localRunId": run.local_run_id,
        "filesApplied": files,
        "success": rec.success,
        "rollbackUsed": rec.rollback_used,
        "appliedAt": _iso(rec.applied_at),
        "createdAt": _iso(rec.created_at),
    }
