from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from shlex import split as shlex_split
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
    database_url: str
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
        raw = self.database_url.strip()
        if raw.startswith("postgresql"):
            return raw.replace("postgresql://", "postgresql+psycopg://", 1)
        # Go-style key=value DSN
        parts: dict[str, str] = {}
        for token in shlex_split(raw):
            if "=" in token:
                k, v = token.split("=", 1)
                parts[k] = v
        user = quote_plus(parts.get("user", "postgres"))
        password = quote_plus(parts.get("password", "postgres"))
        host = parts.get("host", "localhost")
        port = parts.get("port", "5432")
        dbname = parts.get("dbname", "AITestDb")
        return f"postgresql+psycopg://{user}:{password}@{host}:{port}/{dbname}"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def effective_encryption_key(self) -> str:
        return self.encryption_key or self.jwt_key


@lru_cache
def get_settings() -> Settings:
    return Settings()
