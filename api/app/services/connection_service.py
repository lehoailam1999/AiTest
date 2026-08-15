from __future__ import annotations

import uuid

# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session

from app import constants as C
from app.models.domain import AiBackendConnection


def get_or_create_conn(db: Session, project_id: uuid.UUID) -> AiBackendConnection:
    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None:
        conn = AiBackendConnection(
            project_id=project_id,
            status=C.STATUS_NOT_CONFIGURED,
            cli_type="cursor-cli",
            cli_path="agent",
        )
        db.add(conn)
        db.commit()
        db.refresh(conn)
    return conn
