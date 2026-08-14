from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    Integer,
    LargeBinary,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class Project(TimestampMixin, Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = _pk()
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    language: Mapped[str | None] = mapped_column(String(50), nullable=True)
    framework: Mapped[str | None] = mapped_column(String(100), nullable=True)
    meta: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Source(TimestampMixin, Base):
    __tablename__ = "sources"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    source_type: Mapped[str] = mapped_column(String(50))
    title: Mapped[str] = mapped_column(String(300))
    content: Mapped[str] = mapped_column(Text)
    file_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)


class Job(TimestampMixin, Base):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    source_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), index=True, nullable=True
    )
    requirement_snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), index=True, nullable=True
    )
    status: Mapped[str] = mapped_column(String(50), index=True)
    backend_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    generate_strategy: Mapped[str | None] = mapped_column(String(20), nullable=True)
    requirement_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    runner_used: Mapped[str | None] = mapped_column(String(20), nullable=True)
    cli_session_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    progress_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class AiBackendConnection(TimestampMixin, Base):
    __tablename__ = "ai_backend_connections"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), unique=True, index=True
    )
    backend_type: Mapped[str] = mapped_column(String(50), default="openai")
    model_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="NotConfigured")
    api_key_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # AI_CLI only (legacy API_DIRECT coerced at runtime)
    runner_mode: Mapped[str | None] = mapped_column(String(20), nullable=True)
    cli_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    cli_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    cli_args_json: Mapped[str | None] = mapped_column(Text, nullable=True)


class TestCase(TimestampMixin, Base):
    __tablename__ = "test_cases"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    source_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), index=True, nullable=True
    )
    requirement_snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), index=True, nullable=True
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), index=True, nullable=True
    )
    test_case_code: Mapped[str] = mapped_column(String(50))
    title: Mapped[str] = mapped_column(String(500))
    module: Mapped[str | None] = mapped_column(String(200), nullable=True)
    type: Mapped[str] = mapped_column(String(50), default="Chức năng")
    priority: Mapped[str] = mapped_column(String(50), default="Trung bình")
    severity: Mapped[str] = mapped_column(String(50), default="Nặng")
    precondition: Mapped[str | None] = mapped_column(Text, nullable=True)
    steps: Mapped[str] = mapped_column(Text)
    expected_result: Mapped[str] = mapped_column(Text)
    actual_result: Mapped[str | None] = mapped_column(Text, nullable=True)
    test_data: Mapped[str | None] = mapped_column(Text, nullable=True)
    automation_ready: Mapped[bool] = mapped_column(Boolean, default=False)
    is_ai_generated: Mapped[bool] = mapped_column(Boolean, default=False)
    review_status: Mapped[str] = mapped_column(String(50), default="Draft", index=True)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    review_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    execution_status: Mapped[str] = mapped_column(String(50), default="Pending")
    generated_from_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    generated_from_version: Mapped[int | None] = mapped_column(Integer, nullable=True)


class Execution(TimestampMixin, Base):
    __tablename__ = "executions"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    command: Mapped[str] = mapped_column(String(500))
    exit_code: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(50), index=True)
    passed: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    skipped: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    log_excerpt: Mapped[str] = mapped_column(Text, default="")
    trx_file_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    filter: Mapped[str | None] = mapped_column(String(500), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class GenerationCampaign(TimestampMixin, Base):
    __tablename__ = "generation_campaigns"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    scope_level: Mapped[str | None] = mapped_column(String(40), nullable=True)
    scope_label: Mapped[str | None] = mapped_column(String(300), nullable=True)
    status: Mapped[str] = mapped_column(String(50), index=True, default="Running")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class GenerationTask(TimestampMixin, Base):
    __tablename__ = "generation_tasks"

    id: Mapped[uuid.UUID] = _pk()
    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    test_case_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), index=True, nullable=True
    )
    local_run_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    status: Mapped[str] = mapped_column(String(40), default="pending")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class WorkspaceRun(TimestampMixin, Base):
    __tablename__ = "workspace_runs"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    local_run_id: Mapped[str] = mapped_column(String(120), index=True)
    test_type: Mapped[str] = mapped_column(String(40), default="unit")
    test_case_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    module: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status: Mapped[str] = mapped_column(String(50), index=True, default="draft")
    provider: Mapped[str | None] = mapped_column(String(80), nullable=True)
    context_source: Mapped[str | None] = mapped_column(String(40), nullable=True)
    agent_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    agent_override: Mapped[bool] = mapped_column(Boolean, default=False)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class VerifyReportRecord(TimestampMixin, Base):
    __tablename__ = "verify_reports"

    id: Mapped[uuid.UUID] = _pk()
    workspace_run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    compile_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    test_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    coverage_status: Mapped[str | None] = mapped_column(String(40), nullable=True)
    overall_pass: Mapped[bool] = mapped_column(Boolean, default=False)
    summary_json: Mapped[str | None] = mapped_column(Text, nullable=True)


class ApplyAudit(TimestampMixin, Base):
    __tablename__ = "apply_audits"

    id: Mapped[uuid.UUID] = _pk()
    workspace_run_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    files_applied_json: Mapped[str] = mapped_column(Text, default="[]")
    success: Mapped[bool] = mapped_column(Boolean, default=False)
    rollback_used: Mapped[bool] = mapped_column(Boolean, default=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RequirementTopic(TimestampMixin, Base):
    """Normalized topics (W5) — coexists with JSON in sources.description."""

    __tablename__ = "requirement_topics"

    id: Mapped[uuid.UUID] = _pk()
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    title: Mapped[str] = mapped_column(String(300))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    items_json: Mapped[str | None] = mapped_column(Text, nullable=True)


class CoverageUpload(TimestampMixin, Base):
    __tablename__ = "coverage_uploads"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    format: Mapped[str] = mapped_column(String(40), default="lcov")
    line_pct: Mapped[float] = mapped_column(Float, default=0.0)
    branch_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    meta_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ReportRecord(TimestampMixin, Base):
    __tablename__ = "reports"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    title: Mapped[str] = mapped_column(String(300))
    format: Mapped[str] = mapped_column(String(40), default="html")
    meta_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at_report: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class RequirementWorkspace(TimestampMixin, Base):
    """Phase 1 Requirement Studio — container for uploads / knowledge (R1+)."""

    __tablename__ = "requirement_workspaces"

    id: Mapped[uuid.UUID] = _pk()
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    title: Mapped[str] = mapped_column(String(300), default="Requirement Workspace")
    status: Mapped[str] = mapped_column(String(40), default="draft")
    legacy_source_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )


class RequirementFile(TimestampMixin, Base):
    """FileRef — durable upload metadata + raw bytes for re-parse (R1)."""

    __tablename__ = "requirement_files"

    id: Mapped[uuid.UUID] = _pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    file_name: Mapped[str] = mapped_column(String(500))
    mime_type: Mapped[str | None] = mapped_column(String(200), nullable=True)
    byte_size: Mapped[int] = mapped_column(Integer, default=0)
    content_sha256: Mapped[str] = mapped_column(String(64), index=True)
    parse_status: Mapped[str] = mapped_column(String(40), default="pending", index=True)
    parse_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    parser: Mapped[str | None] = mapped_column(String(80), nullable=True)
    parse_warning: Mapped[str | None] = mapped_column(Text, nullable=True)
    extracted_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    preview_html: Mapped[str | None] = mapped_column(Text, nullable=True)
    storage_kind: Mapped[str] = mapped_column(String(20), default="inline")
    content_bytes: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)


class KnowledgeWorkspace(TimestampMixin, Base):
    """R3 — structured Knowledge built from parsed SRS (extracted_text)."""

    __tablename__ = "knowledge_workspaces"

    id: Mapped[uuid.UUID] = _pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), unique=True, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    status: Mapped[str] = mapped_column(String(40), default="empty", index=True)
    version: Mapped[int] = mapped_column(Integer, default=0)
    builder: Mapped[str | None] = mapped_column(String(40), nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    coverage_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_file_count: Mapped[int] = mapped_column(Integer, default=0)
    source_chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    built_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class ChatSession(TimestampMixin, Base):
    """R5 — chat session bound to a Requirement Workspace / Knowledge version."""

    __tablename__ = "chat_sessions"

    id: Mapped[uuid.UUID] = _pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    knowledge_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(300), default="Chat")
    status: Mapped[str] = mapped_column(String(40), default="open")
    knowledge_version: Mapped[int] = mapped_column(Integer, default=0)


class ChatMessage(TimestampMixin, Base):
    """R5 — one chat turn; assistant rows may carry knowledge_diff audit."""

    __tablename__ = "chat_messages"

    id: Mapped[uuid.UUID] = _pk()
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    role: Mapped[str] = mapped_column(String(20))  # user | assistant | system
    content: Mapped[str] = mapped_column(Text)
    knowledge_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    knowledge_diff_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta_json: Mapped[str | None] = mapped_column(Text, nullable=True)


class RequirementSnapshot(TimestampMixin, Base):
    """R6 — immutable Freeze copy of Knowledge (BR-V2-19). Generate TC input only (BR-V2-16)."""

    __tablename__ = "requirement_snapshots"

    id: Mapped[uuid.UUID] = _pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    knowledge_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    knowledge_version: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str] = mapped_column(String(300), default="Requirement Snapshot")
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    coverage_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_file_count: Mapped[int] = mapped_column(Integer, default=0)
    source_chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    frozen_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    freeze_note: Mapped[str | None] = mapped_column(Text, nullable=True)


class RequirementAnalysisRecord(TimestampMixin, Base):
    """Structured persisted analysis slices by fixed type."""

    __tablename__ = "requirement_analysis_records"
    __table_args__ = (
        CheckConstraint(
            "type IN ("
            "'SUMMARY_SCOPE',"
            "'FEATURES',"
            "'ACTORS_PERMISSIONS',"
            "'BUSINESS_FLOWS',"
            "'EXECUTION_CONTEXT',"
            "'BUSINESS_RULES',"
            "'VALIDATION_DATA',"
            "'API_UI',"
            "'ERROR_HANDLING',"
            "'ACCEPTANCE',"
            "'NFR_CONSTRAINTS',"
            "'GAPS'"
            ")",
            name="ck_requirement_analysis_records_type",
        ),
    )

    id: Mapped[uuid.UUID] = _pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    knowledge_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True, index=True
    )
    knowledge_version: Mapped[int] = mapped_column(Integer, default=0, index=True)
    type: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(120))
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    content_json: Mapped[str | None] = mapped_column(Text, nullable=True)