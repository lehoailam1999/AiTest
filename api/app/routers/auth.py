from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.deps import errors, get_current_user
from app.models.user import User
from app.schemas.auth import (
    AuthResponse,
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    StatusResponse,
)
from app.services import auth_service

router = APIRouter(prefix="/api/auth", tags=["auth"])


def auth_payload(payload: AuthResponse) -> JSONResponse:
    return JSONResponse(content=payload.model_dump(by_alias=True, mode="json"))


@router.post("/login")
def login(
    body: LoginRequest,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    email = body.email.lower().strip()
    if not email or not body.password:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=errors("Email and password are required."),
        )
    user = auth_service.get_user_by_email(db, email)
    if user is None or not auth_service.verify_password(body.password, user.password_hash):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content=errors("Invalid email or password."),
        )
    if not user.is_active:
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content=errors("Account is disabled."),
        )
    return auth_payload(auth_service.issue_tokens(db, settings, user))


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(
    body: RegisterRequest,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    email = body.email.lower().strip()
    if auth_service.get_user_by_email(db, email):
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content=errors("Email already registered."),
        )
    user = User(
        email=email,
        password_hash=auth_service.hash_password(body.password),
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return auth_payload(auth_service.issue_tokens(db, settings, user))


@router.post("/refresh")
def refresh(
    body: RefreshRequest,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    if not body.refresh_token:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content=errors("refreshToken is required."),
        )
    user = auth_service.get_user_by_refresh(db, body.refresh_token)
    if user is None or not user.is_active:
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content=errors("Invalid refresh token."),
        )
    expiry = user.refresh_token_expiry
    if expiry is None:
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content=errors("Refresh token expired."),
        )
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=timezone.utc)
    if expiry < datetime.now(timezone.utc):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content=errors("Refresh token expired."),
        )
    return auth_payload(auth_service.issue_tokens(db, settings, user))


@router.get("/me")
def me(user: Annotated[User, Depends(get_current_user)]):
    return JSONResponse(
        content=auth_service.to_user_dto(user).model_dump(by_alias=True, mode="json")
    )


@router.post("/logout", response_model=StatusResponse)
def logout(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    user.refresh_token = None
    user.refresh_token_expiry = None
    db.add(user)
    db.commit()
    return StatusResponse(status="ok")
