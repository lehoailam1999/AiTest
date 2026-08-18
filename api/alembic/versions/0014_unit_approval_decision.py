"""Persist atomic Unit approval decisions.

Revision ID: 0014
Revises: 0013_drop_ai_provider_key_columns
Create Date: 2026-08-16
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014_unit_approval_decision"
down_revision: Union[str, None] = "0013_drop_ai_provider_key_columns"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("test_cases", sa.Column("unit_decision_json", sa.Text(), nullable=True))
    op.add_column("test_cases", sa.Column("unit_tc_ir_json", sa.Text(), nullable=True))
    op.add_column(
        "test_cases", sa.Column("unit_decision_id", sa.String(length=80), nullable=True)
    )
    op.add_column(
        "test_cases",
        sa.Column("unit_content_revision", sa.String(length=80), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("test_cases", "unit_content_revision")
    op.drop_column("test_cases", "unit_decision_id")
    op.drop_column("test_cases", "unit_tc_ir_json")
    op.drop_column("test_cases", "unit_decision_json")
