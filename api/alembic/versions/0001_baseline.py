"""Baseline schema marker (R6).

Greenfield DBs may still use SQLAlchemy create_all on startup.
This revision stamps the current metadata baseline for shared/prod upgrades.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-07-22
"""

from typing import Sequence, Union

revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Baseline: tables created by create_all or prior deploys.
    # Next revisions should use op.create_table / alter after stamping:
    #   alembic stamp head
    pass


def downgrade() -> None:
    pass
