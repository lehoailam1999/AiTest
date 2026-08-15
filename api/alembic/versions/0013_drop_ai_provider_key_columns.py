"""Drop legacy direct-provider columns from ai_backend_connections.

Revision ID: 0013
Revises: 0012_drop_document_chunks
Create Date: 2026-08-15
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0013_drop_ai_provider_key_columns"
down_revision: Union[str, None] = "0012_drop_document_chunks"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE ai_backend_connections DROP COLUMN IF EXISTS api_key_ciphertext"
    )
    op.execute("ALTER TABLE ai_backend_connections DROP COLUMN IF EXISTS backend_type")
    op.execute("ALTER TABLE ai_backend_connections DROP COLUMN IF EXISTS base_url")
    op.execute("ALTER TABLE ai_backend_connections DROP COLUMN IF EXISTS runner_mode")


def downgrade() -> None:
    # Intentionally irreversible: AI credentials must not return to the schema.
    pass
