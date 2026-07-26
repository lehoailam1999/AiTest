"""R4 — coverage_json on knowledge_workspaces.

Revision ID: 0006_knowledge_coverage
Revises: 0005_knowledge_workspaces
Create Date: 2026-07-24
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0006_knowledge_coverage"
down_revision: Union[str, None] = "0005_knowledge_workspaces"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE knowledge_workspaces "
        "ADD COLUMN IF NOT EXISTS coverage_json TEXT"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE knowledge_workspaces DROP COLUMN IF EXISTS coverage_json")
