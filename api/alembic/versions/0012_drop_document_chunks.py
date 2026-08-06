"""Drop DocumentChunk store and requirement_files.chunk_status.

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-04
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0012_drop_document_chunks"
down_revision: Union[str, None] = "0011_execution_context_analysis_type"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_document_chunks_workspace_id")
    op.execute("DROP INDEX IF EXISTS ix_document_chunks_file_id")
    op.execute("DROP TABLE IF EXISTS document_chunks")
    op.execute("DROP INDEX IF EXISTS ix_requirement_files_chunk_status")
    op.execute("ALTER TABLE requirement_files DROP COLUMN IF EXISTS chunk_status")


def downgrade() -> None:
    op.execute(
        "ALTER TABLE requirement_files "
        "ADD COLUMN IF NOT EXISTS chunk_status VARCHAR(40) NOT NULL DEFAULT 'none'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_files_chunk_status "
        "ON requirement_files (chunk_status)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS document_chunks (
            id UUID PRIMARY KEY,
            file_id UUID NOT NULL,
            workspace_id UUID NOT NULL,
            ordinal INTEGER NOT NULL DEFAULT 0,
            text TEXT NOT NULL,
            char_count INTEGER NOT NULL DEFAULT 0,
            heading VARCHAR(500),
            meta_json TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_document_chunks_file_id "
        "ON document_chunks (file_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_document_chunks_workspace_id "
        "ON document_chunks (workspace_id)"
    )
