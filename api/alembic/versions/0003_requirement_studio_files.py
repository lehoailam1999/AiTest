"""R1 — Requirement Workspace + FileRef (requirement_files).

Revision ID: 0003_requirement_studio_files
Revises: 0002_coverage_board_indexes
Create Date: 2026-07-24

Idempotent: safe when tables already exist via Base.metadata.create_all.
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0003_requirement_studio_files"
down_revision: Union[str, None] = "0002_coverage_board_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS requirement_workspaces (
            id UUID PRIMARY KEY,
            project_id UUID NOT NULL,
            title VARCHAR(300) NOT NULL,
            status VARCHAR(40) NOT NULL DEFAULT 'draft',
            legacy_source_id UUID,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_workspaces_project_id "
        "ON requirement_workspaces (project_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_workspaces_legacy_source_id "
        "ON requirement_workspaces (legacy_source_id)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS requirement_files (
            id UUID PRIMARY KEY,
            workspace_id UUID NOT NULL,
            file_name VARCHAR(500) NOT NULL,
            mime_type VARCHAR(200),
            byte_size INTEGER NOT NULL DEFAULT 0,
            content_sha256 VARCHAR(64) NOT NULL,
            parse_status VARCHAR(40) NOT NULL DEFAULT 'pending',
            parse_error TEXT,
            parser VARCHAR(80),
            parse_warning TEXT,
            extracted_text TEXT,
            preview_html TEXT,
            storage_kind VARCHAR(20) NOT NULL DEFAULT 'inline',
            content_bytes BYTEA,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_files_workspace_id "
        "ON requirement_files (workspace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_files_content_sha256 "
        "ON requirement_files (content_sha256)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_files_parse_status "
        "ON requirement_files (parse_status)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_requirement_files_parse_status")
    op.execute("DROP INDEX IF EXISTS ix_requirement_files_content_sha256")
    op.execute("DROP INDEX IF EXISTS ix_requirement_files_workspace_id")
    op.execute("DROP TABLE IF EXISTS requirement_files")
    op.execute("DROP INDEX IF EXISTS ix_requirement_workspaces_legacy_source_id")
    op.execute("DROP INDEX IF EXISTS ix_requirement_workspaces_project_id")
    op.execute("DROP TABLE IF EXISTS requirement_workspaces")
