"""add requirement analysis records table

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-28
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0010_requirement_analysis_records"
down_revision: Union[str, None] = "0009_ai_connection_base_url"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS requirement_analysis_records (
            id UUID PRIMARY KEY,
            workspace_id UUID NOT NULL,
            project_id UUID NOT NULL,
            knowledge_id UUID,
            knowledge_version INTEGER NOT NULL DEFAULT 0,
            type VARCHAR(40) NOT NULL,
            title VARCHAR(120) NOT NULL,
            item_count INTEGER NOT NULL DEFAULT 0,
            content_json TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_analysis_records_workspace_id "
        "ON requirement_analysis_records (workspace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_analysis_records_project_id "
        "ON requirement_analysis_records (project_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_analysis_records_knowledge_id "
        "ON requirement_analysis_records (knowledge_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_analysis_records_knowledge_version "
        "ON requirement_analysis_records (knowledge_version)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_analysis_records_type "
        "ON requirement_analysis_records (type)"
    )



def downgrade() -> None:
    op.drop_index("ix_requirement_analysis_records_type", table_name="requirement_analysis_records")
    op.drop_index(
        "ix_requirement_analysis_records_knowledge_version",
        table_name="requirement_analysis_records",
    )
    op.drop_index("ix_requirement_analysis_records_knowledge_id", table_name="requirement_analysis_records")
    op.drop_index("ix_requirement_analysis_records_project_id", table_name="requirement_analysis_records")
    op.drop_index("ix_requirement_analysis_records_workspace_id", table_name="requirement_analysis_records")
    op.drop_table("requirement_analysis_records")
