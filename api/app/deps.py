from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.models.user import User
from app.services import auth_service

bearer_scheme = HTTPBearer(auto_error=False)


def errors(*messages: str) -> dict:
    return {"errors": list(messages)}


def raise_errors(status_code: int, *messages: str) -> None:
    raise HTTPException(status_code=status_code, detail=errors(*messages))


def get_current_user(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(bearer_scheme)
    ],
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise_errors(status.HTTP_401_UNAUTHORIZED, "Missing or invalid Authorization header.")
    claims = auth_service.safe_parse_token(settings, credentials.credentials)
    if not claims or "uid" not in claims:
        raise_errors(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token.")
    try:
        user_id = uuid.UUID(str(claims["uid"]))
    except ValueError:
        raise_errors(status.HTTP_401_UNAUTHORIZED, "Invalid token subject.")
    user = auth_service.get_user_by_id(db, user_id)
    if user is None or not user.is_active:
        raise_errors(status.HTTP_401_UNAUTHORIZED, "User not found or disabled.")
    return user
