"""R2 — DocumentChunk store + chunk_status on requirement_files.

Revision ID: 0004_document_chunks
Revises: 0003_requirement_studio_files
Create Date: 2026-07-24
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0004_document_chunks"
down_revision: Union[str, None] = "0003_requirement_studio_files"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
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


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_document_chunks_workspace_id")
    op.execute("DROP INDEX IF EXISTS ix_document_chunks_file_id")
    op.execute("DROP TABLE IF EXISTS document_chunks")
    op.execute("DROP INDEX IF EXISTS ix_requirement_files_chunk_status")
    op.execute("ALTER TABLE requirement_files DROP COLUMN IF EXISTS chunk_status")
