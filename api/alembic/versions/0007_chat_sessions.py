"""R5 — chat_sessions + chat_messages.

Revision ID: 0007_chat_sessions
Revises: 0006_knowledge_coverage
Create Date: 2026-07-24
"""

from typing import Sequence, Union

from alembic import op

revision: str = "0007_chat_sessions"
down_revision: Union[str, None] = "0006_knowledge_coverage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id UUID PRIMARY KEY,
            workspace_id UUID NOT NULL,
            knowledge_id UUID,
            title VARCHAR(300) NOT NULL DEFAULT 'Chat',
            status VARCHAR(40) NOT NULL DEFAULT 'open',
            knowledge_version INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_chat_sessions_workspace_id "
        "ON chat_sessions (workspace_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_chat_sessions_knowledge_id "
        "ON chat_sessions (knowledge_id)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_messages (
            id UUID PRIMARY KEY,
            session_id UUID NOT NULL,
            workspace_id UUID NOT NULL,
            role VARCHAR(20) NOT NULL,
            content TEXT NOT NULL,
            knowledge_version INTEGER,
            knowledge_diff_json TEXT,
            meta_json TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            deleted_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_chat_messages_session_id "
        "ON chat_messages (session_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_chat_messages_workspace_id "
        "ON chat_messages (workspace_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_chat_messages_workspace_id")
    op.execute("DROP INDEX IF EXISTS ix_chat_messages_session_id")
    op.execute("DROP TABLE IF EXISTS chat_messages")
    op.execute("DROP INDEX IF EXISTS ix_chat_sessions_knowledge_id")
    op.execute("DROP INDEX IF EXISTS ix_chat_sessions_workspace_id")
    op.execute("DROP TABLE IF EXISTS chat_sessions")
