from __future__ import annotations

from sqlalchemy.orm import Session

from app import constants as C
from app.models.domain import AiBackendConnection, Project
from app.models.user import User
from app.services.auth_service import hash_password


def seed_admin(db: Session) -> None:
    count = db.query(User).filter(User.deleted_at.is_(None)).count()
    if count > 0:
        return
    admin = User(
        email="admin@aitest.com",
        password_hash=hash_password("Admin@123"),
        first_name="Admin",
        last_name="User",
        is_active=True,
    )
    db.add(admin)

    project = Project(
        name="Demo Project",
        description="Sample project for Phase 1",
        code="DEMO",
        is_active=True,
    )
    db.add(project)
    db.flush()

    db.add(
        AiBackendConnection(
            project_id=project.id,
            backend_type=C.PROVIDER_OLLAMA,
            status=C.STATUS_DISCONNECTED,
        )
    )
    db.commit()
