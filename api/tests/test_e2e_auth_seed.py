"""Tests for AI auth seed artifacts + markers (no live LLM)."""

from __future__ import annotations

import json
from pathlib import Path

from app.services.e2e_auth_bootstrap import discover_project_auth, merge_discovered_auth
from app.services.e2e_auth_seed import (
    attach_auth_markers_to_test_data,
    load_auth_artifact,
    parse_auth_markers,
    save_auth_artifact,
)


def test_save_and_load_auth_artifact(tmp_path: Path):
    save_auth_artifact(
        tmp_path,
        role="default",
        username="e2e@aitest.local",
        password="E2e!Default9x",
    )
    art = load_auth_artifact(tmp_path, "default")
    assert art is not None
    assert art["username"] == "e2e@aitest.local"
    assert (tmp_path / ".ai-test" / "auth" / ".gitignore").is_file()


def test_discover_prefers_auth_seed_over_env(tmp_path: Path):
    (tmp_path / ".env").write_text(
        "E2E_USERNAME=env@x.com\nE2E_PASSWORD=envpass\n",
        encoding="utf-8",
    )
    save_auth_artifact(
        tmp_path,
        role="default",
        username="seed@aitest.local",
        password="SeedPass1",
    )
    d = discover_project_auth(str(tmp_path))
    profile = d.pick("default")
    assert profile is not None
    assert profile.username == "seed@aitest.local"
    assert profile.source == "auth-seed"
    assert profile.skipped_seed is True


def test_skip_seed_when_artifact_exists(tmp_path: Path):
    """load_auth_artifact returns data → ensure_auth_seed would skip (unit of skip gate)."""
    save_auth_artifact(
        tmp_path, role="admin", username="a@x.com", password="Admin1x!"
    )
    assert load_auth_artifact(tmp_path, "admin") is not None
    assert load_auth_artifact(tmp_path, "missing") is None


def test_auth_markers_roundtrip():
    td = attach_auth_markers_to_test_data(
        "foo: bar\n",
        role="default",
        auth_rel=".ai-test/auth/default.json",
    )
    role, ref = parse_auth_markers(td, None)
    assert role == "default"
    assert ref == ".ai-test/auth/default.json"
    # Re-attach replaces old markers
    td2 = attach_auth_markers_to_test_data(
        td, role="admin", auth_rel=".ai-test/auth/admin.json"
    )
    role2, ref2 = parse_auth_markers(td2, None)
    assert role2 == "admin"
    assert ref2 == ".ai-test/auth/admin.json"
    assert "authRole: default" not in td2


def test_merge_uses_auth_ref_from_test_data(tmp_path: Path):
    save_auth_artifact(
        tmp_path,
        role="staff",
        username="staff@aitest.local",
        password="Staff9x!",
    )
    env, _files, _d = merge_discovered_auth(
        {},
        project_root=str(tmp_path),
        tc_test_data="authRole: staff\nauthRef: .ai-test/auth/staff.json\n",
    )
    assert env.get("E2E_USERNAME") == "staff@aitest.local"
    assert env.get("E2E_PASSWORD") == "Staff9x!"


def test_merge_body_override_wins(tmp_path: Path):
    save_auth_artifact(
        tmp_path,
        role="default",
        username="seed@aitest.local",
        password="SeedPass1",
    )
    env, _, _ = merge_discovered_auth(
        {"e2eUsername": "override@x.com", "e2ePassword": "override"},
        project_root=str(tmp_path),
    )
    assert env["E2E_USERNAME"] == "override@x.com"
    assert env["E2E_PASSWORD"] == "override"


def test_discover_to_dict_hides_seed_password(tmp_path: Path):
    save_auth_artifact(
        tmp_path, role="default", username="a@b.com", password="secret-seed"
    )
    dto = discover_project_auth(str(tmp_path)).to_dict()
    assert dto["ready"] is True
    assert "secret-seed" not in json.dumps(dto)
