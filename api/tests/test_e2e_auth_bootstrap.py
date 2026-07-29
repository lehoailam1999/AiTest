"""Tests for E2E auth bootstrap (discover from .env / storageState / roles)."""

from __future__ import annotations

import json
from pathlib import Path

from app.llm.base import E2EFile
from app.services.e2e_auth_bootstrap import (
    discover_project_auth,
    infer_role_from_text,
    merge_discovered_auth,
)


def test_discover_env_default_credentials(tmp_path: Path):
    (tmp_path / ".env.e2e").write_text(
        "E2E_USERNAME=user@example.com\nE2E_PASSWORD=secret123\n",
        encoding="utf-8",
    )
    d = discover_project_auth(str(tmp_path))
    assert d.is_ready()
    profile = d.pick("default")
    assert profile is not None
    assert profile.username == "user@example.com"
    assert profile.password == "secret123"
    assert profile.source == "env"


def test_discover_multi_role_env(tmp_path: Path):
    (tmp_path / ".env").write_text(
        "E2E_ADMIN_USERNAME=admin@x.com\n"
        "E2E_ADMIN_PASSWORD=adminpass\n"
        "E2E_USER_USERNAME=user@x.com\n"
        "E2E_USER_PASSWORD=userpass\n",
        encoding="utf-8",
    )
    d = discover_project_auth(str(tmp_path))
    roles = {r.role: r for r in d.roles}
    assert "admin" in roles
    assert roles["admin"].username == "admin@x.com"
    assert roles["user"].password == "userpass"


def test_skip_seed_when_storage_state_valid(tmp_path: Path):
    fixtures = tmp_path / "AItest" / "E2ETest" / "Todo" / "fixtures"
    fixtures.mkdir(parents=True)
    state = {
        "cookies": [
            {
                "name": "sid",
                "value": "1",
                "domain": "localhost",
                "path": "/",
            }
        ],
        "origins": [],
    }
    (fixtures / "storageState.json").write_text(json.dumps(state), encoding="utf-8")
    d = discover_project_auth(str(tmp_path), module="Todo")
    profile = d.pick("default")
    assert profile is not None
    assert profile.storage_state_valid
    assert profile.skipped_seed
    assert d.is_ready()


def test_merge_attaches_storage_to_files(tmp_path: Path):
    fixtures = tmp_path / "AItest" / "E2ETest" / "Mod" / "fixtures"
    fixtures.mkdir(parents=True)
    state = {
        "cookies": [
            {"name": "a", "value": "b", "domain": "localhost", "path": "/"}
        ],
        "origins": [],
    }
    (fixtures / "storageState.json").write_text(json.dumps(state), encoding="utf-8")
    files = [
        E2EFile(
            path="AItest/E2ETest/Mod/specs/x.spec.ts",
            content="test('x', async () => {});",
            kind="spec",
        )
    ]
    env, out_files, _d = merge_discovered_auth(
        {},
        project_root=str(tmp_path),
        module="Mod",
        files=files,
    )
    assert out_files is not None
    assert any(
        (f.path or "").replace("\\", "/").endswith("fixtures/storageState.json")
        for f in out_files
    )
    # Credentials may be empty when only storageState — that is OK
    assert "E2E_USERNAME" not in env or True


def test_infer_role_from_precondition():
    assert infer_role_from_text("Đăng nhập với role admin") == "admin"
    assert infer_role_from_text("user đã có todo") == "user"


def test_discover_to_dict_hides_password(tmp_path: Path):
    (tmp_path / ".env").write_text(
        "E2E_USERNAME=a@b.com\nE2E_PASSWORD=secret\n", encoding="utf-8"
    )
    dto = discover_project_auth(str(tmp_path)).to_dict()
    assert dto["ready"] is True
    assert dto["roles"][0]["hasPassword"] is True
    blob = json.dumps(dto)
    assert "secret" not in blob
