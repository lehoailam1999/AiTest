from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.config import Settings
from app.models.user import User
from app.schemas.auth import AuthResponse, UserDTO

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

REFRESH_DAYS = 7


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def create_access_token(settings: Settings, user: User) -> tuple[str, datetime]:
    expires_at = datetime.now(timezone.utc) + timedelta(hours=settings.jwt_access_hours)
    payload = {
        "uid": str(user.id),
        "email": user.email,
        "sub": str(user.id),
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "iat": datetime.now(timezone.utc),
        "exp": expires_at,
    }
    token = jwt.encode(payload, settings.jwt_key, algorithm="HS256")
    return token, expires_at


def parse_access_token(settings: Settings, token: str) -> dict:
    return jwt.decode(
        token,
        settings.jwt_key,
        algorithms=["HS256"],
        audience=settings.jwt_audience,
        issuer=settings.jwt_issuer,
    )


def new_refresh_token() -> str:
    return f"{uuid.uuid4()}{uuid.uuid4()}"


def issue_tokens(db: Session, settings: Settings, user: User) -> AuthResponse:
    access_token, expires_at = create_access_token(settings, user)
    refresh = new_refresh_token()
    user.refresh_token = refresh
    user.refresh_token_expiry = datetime.now(timezone.utc) + timedelta(days=REFRESH_DAYS)
    user.last_login_at = datetime.now(timezone.utc)
    db.add(user)
    db.commit()
    db.refresh(user)
    return AuthResponse(
        access_token=access_token,
        refresh_token=refresh,
        expires_at=expires_at,
        user=to_user_dto(user),
    )


def to_user_dto(user: User) -> UserDTO:
    return UserDTO(
        id=user.id,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        avatar_url=user.avatar_url,
        is_active=user.is_active,
    )


def get_user_by_email(db: Session, email: str) -> User | None:
    return (
        db.query(User)
        .filter(User.email == email.lower().strip(), User.deleted_at.is_(None))
        .first()
    )


def get_user_by_id(db: Session, user_id: uuid.UUID) -> User | None:
    return (
        db.query(User)
        .filter(User.id == user_id, User.deleted_at.is_(None))
        .first()
    )


def get_user_by_refresh(db: Session, refresh_token: str) -> User | None:
    return (
        db.query(User)
        .filter(
            User.refresh_token == refresh_token,
            User.deleted_at.is_(None),
        )
        .first()
    )


def safe_parse_token(settings: Settings, token: str) -> dict | None:
    try:
        return parse_access_token(settings, token)
    except JWTError:
        return None
