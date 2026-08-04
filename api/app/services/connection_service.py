from __future__ import annotations

import uuid

# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session

from app import constants as C
from app.config import get_settings
from app.llm.providers import Antigravity, Ollama, Provider, for_provider
from app.models.domain import AiBackendConnection
from app.services import secret


def enc_key() -> bytes:
    return secret.derive_key(get_settings().effective_encryption_key)


def get_or_create_conn(db: Session, project_id: uuid.UUID) -> AiBackendConnection:
    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None:
        conn = AiBackendConnection(
            project_id=project_id,
            # Keep defaults aligned with how projects are seeded/created
            # so that deleting connection rows and recreating yields same behavior.
            backend_type=C.PROVIDER_OLLAMA,
            status=C.STATUS_DISCONNECTED,
            runner_mode="AI_CLI",
        )
        db.add(conn)
        db.commit()
        db.refresh(conn)
    return conn


def connection_api_key(conn: AiBackendConnection) -> str:
    """Return decrypted key; empty only for ollama or local antigravity proxy."""
    if conn.api_key_ciphertext:
        return secret.decrypt(conn.api_key_ciphertext, enc_key())
    backend = (conn.backend_type or "").lower()
    if backend == C.PROVIDER_OLLAMA:
        return ""
    if backend == C.PROVIDER_ANTIGRAVITY:
        base = (getattr(conn, "base_url", None) or "").strip().lower()
        # Local OpenAI-compatible proxy may omit key; cloud Gemini mode needs key.
        if base and ("127.0.0.1" in base or "localhost" in base):
            return ""
        raise ValueError(
            "API Key chưa được cấu hình — Antigravity cloud cần Google API Key (giống Gemini)"
        )
    raise ValueError("API Key chưa được cấu hình")


def llm_from_connection(conn: AiBackendConnection) -> Provider:
    provider = for_provider(conn.backend_type)
    model = (conn.model_name or "").strip()
    base = (getattr(conn, "base_url", None) or "").strip() or None
    if isinstance(provider, Ollama):
        if model:
            provider.model = model
        if base:
            provider._base_url = base
    elif isinstance(provider, Antigravity):
        if model:
            provider.model = model
        if base:
            provider._base_url = base
    return provider
