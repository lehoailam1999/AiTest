"""R3 — knowledge_workspaces table.

Revision ID: 0005_knowledge_workspaces
Revises: 0004_document_chunks
Create Date: 2026-07-24
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0005_knowledge_workspaces"
down_revision: Union[str, None] = "0004_document_chunks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS knowledge_workspaces (
            id UUID PRIMARY KEY,
            workspace_id UUID NOT NULL,
            project_id UUID NOT NULL,
            status VARCHAR(40) NOT NULL DEFAULT 'empty',
            version INTEGER NOT NULL DEFAULT 0,
            builder VARCHAR(40),
            summary TEXT,
            payload_json TEXT,
            source_file_count INTEGER NOT NULL DEFAULT 0,
            source_chunk_count INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            built_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_knowledge_workspaces_workspace_id "
        "ON knowledge_workspaces (workspace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_knowledge_workspaces_project_id "
        "ON knowledge_workspaces (project_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_knowledge_workspaces_status "
        "ON knowledge_workspaces (status)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_knowledge_workspaces_status")
    op.execute("DROP INDEX IF EXISTS ix_knowledge_workspaces_project_id")
    op.execute("DROP INDEX IF EXISTS ux_knowledge_workspaces_workspace_id")
    op.execute("DROP TABLE IF EXISTS knowledge_workspaces")
