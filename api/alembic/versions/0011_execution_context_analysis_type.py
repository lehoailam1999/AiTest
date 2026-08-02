"""allow EXECUTION_CONTEXT analysis record type

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-02
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0011_execution_context_analysis_type"
down_revision: Union[str, None] = "0010_requirement_analysis_records"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TYPES_WITH_EXEC = (
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
    ")"
)

_TYPES_LEGACY = (
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
    ")"
)


def upgrade() -> None:
    op.drop_constraint(
        "ck_requirement_analysis_records_type",
        "requirement_analysis_records",
        type_="check",
    )
    op.create_check_constraint(
        "ck_requirement_analysis_records_type",
        "requirement_analysis_records",
        _TYPES_WITH_EXEC,
    )


def downgrade() -> None:
    op.execute(
        "UPDATE requirement_analysis_records "
        "SET deleted_at = NOW() "
        "WHERE type = 'EXECUTION_CONTEXT' AND deleted_at IS NULL"
    )
    op.drop_constraint(
        "ck_requirement_analysis_records_type",
        "requirement_analysis_records",
        type_="check",
    )
    op.create_check_constraint(
        "ck_requirement_analysis_records_type",
        "requirement_analysis_records",
        _TYPES_LEGACY,
    )
