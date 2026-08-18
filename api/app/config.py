from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from urllib.parse import quote_plus

from pydantic_settings import BaseSettings, SettingsConfigDict

_API_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Local: api/.env. Docker Compose injects process env and overrides this.
        env_file=str(_API_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    port: int = 8000
    postgres_user: str = "postgres"
    postgres_password: str
    postgres_db: str = "AITestDb"
    postgres_host: str = "localhost"
    postgres_port: int = 5433
    # Optional override (Compose injects this for the API container).
    database_url: str | None = None
    jwt_key: str
    encryption_key: str | None = None
    jwt_issuer: str = "AITest.API"
    jwt_audience: str = "AITest.Client"
    jwt_access_hours: int = 8
    cors_origins: str
    # Workspace metadata SQLite (paths only — never source content)
    workspace_meta_db: str | None = None
    workspace_enable_watcher: bool = False

    @property
    def sqlalchemy_url(self) -> str:
        raw = (self.database_url or "").strip()
        if raw.startswith("postgresql+psycopg://"):
            return raw
        if raw.startswith("postgresql://"):
            return raw.replace("postgresql://", "postgresql+psycopg://", 1)
        user = quote_plus(self.postgres_user)
        password = quote_plus(self.postgres_password)
        return (
            f"postgresql+psycopg://{user}:{password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def effective_encryption_key(self) -> str:
        return self.encryption_key or self.jwt_key


@lru_cache
def get_settings() -> Settings:
    return Settings()
