"""R6 — requirement_snapshots + requirement_snapshot_id on jobs / test_cases.

Revision ID: 0008_requirement_snapshots
Revises: 0007_chat_sessions
Create Date: 2026-07-24
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0008_requirement_snapshots"
down_revision: Union[str, None] = "0007_chat_sessions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS requirement_snapshots (
            id UUID PRIMARY KEY,
            workspace_id UUID NOT NULL,
            project_id UUID NOT NULL,
            knowledge_id UUID,
            knowledge_version INTEGER NOT NULL DEFAULT 0,
            title VARCHAR(300) NOT NULL DEFAULT 'Requirement Snapshot',
            summary TEXT,
            payload_json TEXT,
            coverage_json TEXT,
            source_file_count INTEGER NOT NULL DEFAULT 0,
            source_chunk_count INTEGER NOT NULL DEFAULT 0,
            frozen_by UUID,
            freeze_note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_snapshots_workspace_id "
        "ON requirement_snapshots (workspace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_requirement_snapshots_project_id "
        "ON requirement_snapshots (project_id)"
    )

    op.execute(
        "ALTER TABLE test_cases "
        "ADD COLUMN IF NOT EXISTS requirement_snapshot_id UUID"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_test_cases_requirement_snapshot_id "
        "ON test_cases (requirement_snapshot_id)"
    )

    op.execute(
        "ALTER TABLE jobs "
        "ADD COLUMN IF NOT EXISTS requirement_snapshot_id UUID"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_jobs_requirement_snapshot_id "
        "ON jobs (requirement_snapshot_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_jobs_requirement_snapshot_id")
    op.execute(
        "ALTER TABLE jobs DROP COLUMN IF EXISTS requirement_snapshot_id"
    )
    op.execute("DROP INDEX IF EXISTS ix_test_cases_requirement_snapshot_id")
    op.execute(
        "ALTER TABLE test_cases DROP COLUMN IF EXISTS requirement_snapshot_id"
    )
    op.execute("DROP INDEX IF EXISTS ix_requirement_snapshots_project_id")
    op.execute("DROP INDEX IF EXISTS ix_requirement_snapshots_workspace_id")
    op.execute("DROP TABLE IF EXISTS requirement_snapshots")
