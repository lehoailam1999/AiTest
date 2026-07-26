from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class CamelModel(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
        from_attributes=True,
    )


class LoginRequest(CamelModel):
    email: EmailStr
    password: str


class RegisterRequest(CamelModel):
    email: EmailStr
    password: str = Field(min_length=8)
    first_name: str = Field(alias="firstName", min_length=1)
    last_name: str = Field(alias="lastName", min_length=1)


class RefreshRequest(CamelModel):
    refresh_token: str = Field(alias="refreshToken")


class UserDTO(CamelModel):
    id: UUID
    email: str
    first_name: str = Field(serialization_alias="firstName")
    last_name: str = Field(serialization_alias="lastName")
    avatar_url: str | None = Field(default=None, serialization_alias="avatarUrl")
    is_active: bool = Field(serialization_alias="isActive")


class AuthResponse(CamelModel):
    access_token: str = Field(serialization_alias="accessToken")
    refresh_token: str = Field(serialization_alias="refreshToken")
    expires_at: datetime = Field(serialization_alias="expiresAt")
    user: UserDTO


class StatusResponse(CamelModel):
    status: str
