"""add ai connection base_url

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-24
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009_ai_connection_base_url"
down_revision: Union[str, None] = "0008_requirement_snapshots"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Idempotent: column may already exist if schema was created outside Alembic.
    op.execute(
        "ALTER TABLE ai_backend_connections "
        "ADD COLUMN IF NOT EXISTS base_url VARCHAR(500)"
    )


def downgrade() -> None:
    op.drop_column("ai_backend_connections", "base_url")
