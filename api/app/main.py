from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.database import Base, SessionLocal, engine
from app.models import (  # noqa: F401 — register metadata
    ChatMessage,
    ChatSession,
    CoverageUpload,
    KnowledgeWorkspace,
    ReportRecord,
    RequirementFile,
    RequirementTopic,
    RequirementWorkspace,
    User,
)
from app.routers import (
    agent,
    audit,
    auth,
    connection,
    executions,
    generate_api_test,
    generate_e2e,
    generate_unit,
    health,
    jobs,
    projects,
    resolve_source,
    sources,
    testcases,
)
from app.features.generation.integration import router as integration_router
from app.features.journey.api import router as journey_router
from app.features.reporting.api import router as reporting_router
from app.features.coverage_board.api import router as coverage_board_router
from app.features.requirement_studio.api import router as requirement_studio_router
from app.features.workspace.api import router as workspace_router
from app.seed import seed_admin

settings = get_settings()

app = FastAPI(title="AITest API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Accept", "Authorization", "Content-Type"],
    max_age=300,
)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_: Request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and "errors" in detail:
        return JSONResponse(status_code=exc.status_code, content=detail)
    if isinstance(detail, list):
        return JSONResponse(status_code=exc.status_code, content={"errors": detail})
    return JSONResponse(status_code=exc.status_code, content={"errors": [str(detail)]})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_: Request, exc: RequestValidationError):
    messages = []
    for err in exc.errors():
        loc = ".".join(str(x) for x in err.get("loc", []) if x != "body")
        msg = err.get("msg", "Invalid value")
        messages.append(f"{loc}: {msg}" if loc else msg)
    return JSONResponse(status_code=400, content={"errors": messages})


@app.exception_handler(Exception)
async def unhandled_exception_handler(_: Request, exc: Exception):
    """Hardening (W7): never leak stack to client."""
    return JSONResponse(
        status_code=500,
        content={"errors": ["Internal server error. Check API logs."]},
    )


@app.on_event("startup")
def on_startup() -> None:
    _bootstrap_schema_if_greenfield()
    _ensure_project_meta_columns()
    _ensure_indexes()
    db = SessionLocal()
    try:
        seed_admin(db)
    finally:
        db.close()


def _bootstrap_schema_if_greenfield() -> None:
    """Create tables only on a DB that Alembic does not manage yet.

    Once ``alembic_version`` exists, schema changes must go through
    ``npm run db:migrate`` + ``npm run db:up`` so model edits are not silently
    applied on API startup.
    """
    from sqlalchemy import inspect

    if inspect(engine).has_table("alembic_version"):
        return
    Base.metadata.create_all(bind=engine)


def _ensure_project_meta_columns() -> None:
    """Best-effort schema patches. Use short lock_timeout so idle-in-transaction
    sessions from a previous hung API cannot block startup forever."""
    from sqlalchemy import text
    import logging

    log = logging.getLogger("aitest.startup")
    stmts = [
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS language VARCHAR(50)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS framework VARCHAR(100)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS meta TEXT",
    ]
    tc_stmts = [
        "ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS generated_from_hash VARCHAR(64)",
        "ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS generated_from_version INTEGER",
    ]
    job_stmts = [
        "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS generate_strategy VARCHAR(20)",
        "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requirement_version INTEGER",
        "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS runner_used VARCHAR(20)",
        "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cli_session_key VARCHAR(120)",
        "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress_message TEXT",
    ]
    conn_stmts = [
        "ALTER TABLE ai_backend_connections ADD COLUMN IF NOT EXISTS cli_type VARCHAR(40)",
        "ALTER TABLE ai_backend_connections ADD COLUMN IF NOT EXISTS cli_path VARCHAR(500)",
        "ALTER TABLE ai_backend_connections ADD COLUMN IF NOT EXISTS cli_args_json TEXT",
    ]
    ws_stmts = [
        "ALTER TABLE workspace_runs ADD COLUMN IF NOT EXISTS context_source VARCHAR(40)",
        "ALTER TABLE workspace_runs ADD COLUMN IF NOT EXISTS agent_confidence DOUBLE PRECISION",
        "ALTER TABLE workspace_runs ADD COLUMN IF NOT EXISTS agent_override BOOLEAN DEFAULT FALSE",
    ]
    studio_stmts = [
        "ALTER TABLE knowledge_workspaces ADD COLUMN IF NOT EXISTS coverage_json TEXT",
        # Remove legacy ChunkStore (SRS Phân tích uses extracted_text only)
        "DROP TABLE IF EXISTS document_chunks CASCADE",
        "DROP INDEX IF EXISTS ix_requirement_files_chunk_status",
        "ALTER TABLE requirement_files DROP COLUMN IF EXISTS chunk_status",
    ]
    all_stmts = stmts + tc_stmts + job_stmts + conn_stmts + ws_stmts + studio_stmts
    # One transaction per statement — a lock timeout must not abort the whole batch
    # (Postgres: InFailedSqlTransaction cascades if we keep using the same txn).
    for sql in all_stmts:
        try:
            with engine.begin() as conn:
                conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                conn.execute(text(sql))
        except Exception as exc:  # noqa: BLE001
            log.warning("schema patch skipped (%s): %s", sql.split()[2], exc)

def _ensure_indexes() -> None:
    from sqlalchemy import text

    stmts = [
        "CREATE INDEX IF NOT EXISTS ix_test_cases_project_module_review "
        "ON test_cases (project_id, module, review_status)",
        "CREATE INDEX IF NOT EXISTS ix_requirement_topics_source "
        "ON requirement_topics (source_id)",
        "CREATE INDEX IF NOT EXISTS ix_workspace_runs_project_module_status "
        "ON workspace_runs (project_id, module, status)",
        "CREATE INDEX IF NOT EXISTS ix_requirement_topics_project "
        "ON requirement_topics (project_id)",
    ]
    with engine.begin() as conn:
        for sql in stmts:
            try:
                conn.execute(text(sql))
            except Exception:
                pass


# Legacy routers (URL unchanged) + new feature routers (W2/W4/W6/W7)
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(connection.router)
app.include_router(sources.router)
app.include_router(jobs.router)
app.include_router(testcases.router)
app.include_router(generate_unit.router)
app.include_router(generate_api_test.router)
app.include_router(generate_e2e.router)
app.include_router(agent.router)
app.include_router(resolve_source.router)
app.include_router(workspace_router)
app.include_router(integration_router)
app.include_router(executions.router)
app.include_router(audit.router)
app.include_router(reporting_router)
app.include_router(journey_router)
app.include_router(coverage_board_router)
app.include_router(requirement_studio_router)
