"""add requirement analysis records table

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-28
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0010_requirement_analysis_records"
down_revision: Union[str, None] = "0009_ai_connection_base_url"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "requirement_analysis_records",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("knowledge_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("knowledge_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("type", sa.String(length=40), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("item_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("content_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "type IN ("
            "'SUMMARY_SCOPE',"
            "'FEATURES',"
            "'ACTORS_PERMISSIONS',"
            "'BUSINESS_FLOWS',"
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
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_requirement_analysis_records_workspace_id",
        "requirement_analysis_records",
        ["workspace_id"],
    )
    op.create_index(
        "ix_requirement_analysis_records_project_id",
        "requirement_analysis_records",
        ["project_id"],
    )
    op.create_index(
        "ix_requirement_analysis_records_knowledge_id",
        "requirement_analysis_records",
        ["knowledge_id"],
    )
    op.create_index(
        "ix_requirement_analysis_records_knowledge_version",
        "requirement_analysis_records",
        ["knowledge_version"],
    )
    op.create_index(
        "ix_requirement_analysis_records_type",
        "requirement_analysis_records",
        ["type"],
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
