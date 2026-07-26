"""F6 — indexes for Coverage Board aggregate queries.

Revision ID: 0002_coverage_board_indexes
Revises: 0001_baseline
Create Date: 2026-07-22
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0002_coverage_board_indexes"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_test_cases_project_module_review "
        "ON test_cases (project_id, module, review_status)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_workspace_runs_project_module_status "
        "ON workspace_runs (project_id, module, status)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_topics_project "
        "ON requirement_topics (project_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_requirement_topics_project")
    op.execute("DROP INDEX IF EXISTS ix_workspace_runs_project_module_status")
    op.execute("DROP INDEX IF EXISTS ix_test_cases_project_module_review")
