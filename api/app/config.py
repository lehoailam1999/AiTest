from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    port: int = 5000
    database_url: str = (
        "host=localhost user=postgres password=postgres "
        "dbname=AITestDb port=5433 sslmode=disable TimeZone=UTC"
    )
    jwt_key: str = "AITest-Super-Secret-Key-Min-32-Chars-Long!"
    encryption_key: str | None = None
    jwt_issuer: str = "AITest.API"
    jwt_audience: str = "AITest.Client"
    jwt_access_hours: int = 8
    cors_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:4200,http://localhost:4300,"
        "tauri://localhost,http://tauri.localhost,https://tauri.localhost"
    )
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
        for token in raw.split():
            if "=" in token:
                k, v = token.split("=", 1)
                parts[k] = v
        user = parts.get("user", "postgres")
        password = parts.get("password", "postgres")
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
