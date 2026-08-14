"""Tests for deterministic SUT auth mining + multi-role env."""

from __future__ import annotations

import json
from pathlib import Path

from app.services.e2e_auth_bootstrap import (
    auth_env_for_role,
    discover_project_auth,
    parse_roles_list,
)
from app.services.e2e_auth_sut_mine import (
    is_jhipster_project,
    materialize_mined_auth_artifacts,
    mine_sut_credentials,
)


def test_mine_jhipster_i18n_and_defaults(tmp_path: Path):
    (tmp_path / ".yo-rc.json").write_text(
        json.dumps({"generator-jhipster": {"baseName": "demo"}}),
        encoding="utf-8",
    )
    i18n = (
        tmp_path
        / "src"
        / "Forensic"
        / "ClientApp"
        / "src"
        / "i18n"
        / "vi"
        / "global.json"
    )
    i18n.parent.mkdir(parents=True)
    # Mirror Forensic on-disk JSON (escaped quotes inside the string value).
    i18n.write_text(
        '{\n  "login": { "messages": { "info": { "authenticated": {\n'
        '    "suffix": "tài khoản=\\"admin\\" và mật khẩu=\\"admin\\" '
        'tài khoản=\\"user\\" và mật khẩu=\\"user\\"."\n'
        "  } } } }\n}\n",
        encoding="utf-8",
    )
    assert is_jhipster_project(tmp_path)
    creds = {c.role: c for c in mine_sut_credentials(tmp_path)}
    assert creds["admin"].username == "admin"
    assert creds["admin"].password == "admin"
    assert creds["user"].username == "user"
    assert "default" in creds
    assert "director" not in creds
    assert "staff" not in creds
    assert "manager" not in creds


def test_mine_e2e_seed_roles_ts(tmp_path: Path):
    pkg = tmp_path / "test" / "App.E2E"
    roles = pkg / "support" / "config" / "roles.ts"
    roles.parent.mkdir(parents=True)
    roles.write_text(
        "const defaultPassword = process.env.E2E_SEED_PASSWORD ?? 'user';\n"
        "export const E2E_SEED_ACCOUNTS = {\n"
        "  admin: {\n"
        "    username: process.env.E2E_ADMIN_USERNAME ?? 'admin',\n"
        "    password: process.env.E2E_ADMIN_PASSWORD ?? 'admin',\n"
        "  },\n"
        "  director: {\n"
        "    username: process.env.E2E_DIRECTOR_USERNAME ?? 'dir_c09a',\n"
        "    password: process.env.E2E_DIRECTOR_PASSWORD ?? defaultPassword,\n"
        "  },\n"
        "};\n",
        encoding="utf-8",
    )
    aitest = tmp_path / ".ai-test"
    aitest.mkdir()
    (aitest / "project.profile.json").write_text(
        json.dumps(
            {
                "playwrightRun": {"packageRoot": "test/App.E2E"},
                "auth": {
                    "strategy": "uiLogin",
                    "roles": ["admin", "director"],
                    "seedFiles": [],
                },
            }
        ),
        encoding="utf-8",
    )
    creds = {c.role: c for c in mine_sut_credentials(tmp_path)}
    assert creds["admin"].username == "admin"
    assert creds["admin"].password == "admin"
    assert creds["director"].username == "dir_c09a"
    assert creds["director"].password == "user"
    assert "staff" not in creds
    written = materialize_mined_auth_artifacts(tmp_path)
    assert set(written) == {"admin", "director"}
    assert not (tmp_path / ".ai-test" / "auth" / "staff.json").is_file()


def test_materialize_seed_file_roles_when_profile_roles_empty(tmp_path: Path):
    """E2E roles.ts is SoT — persist those accounts even if auth.roles is []."""
    pkg = tmp_path / "test" / "App.E2E"
    roles = pkg / "support" / "config" / "roles.ts"
    roles.parent.mkdir(parents=True)
    roles.write_text(
        "const defaultPassword = process.env.E2E_SEED_PASSWORD ?? 'user';\n"
        "export const E2E_SEED_ACCOUNTS = {\n"
        "  admin: {\n"
        "    username: process.env.E2E_ADMIN_USERNAME ?? 'admin',\n"
        "    password: process.env.E2E_ADMIN_PASSWORD ?? 'admin',\n"
        "  },\n"
        "  head: {\n"
        "    username: process.env.E2E_HEAD_USERNAME ?? 'head_c09a',\n"
        "    password: process.env.E2E_HEAD_PASSWORD ?? defaultPassword,\n"
        "  },\n"
        "};\n",
        encoding="utf-8",
    )
    aitest = tmp_path / ".ai-test"
    aitest.mkdir()
    (aitest / "project.profile.json").write_text(
        json.dumps(
            {
                "playwrightRun": {"packageRoot": "test/App.E2E"},
                "auth": {
                    "strategy": "uiLogin",
                    "roles": [],
                    "seedFiles": ["test/App.E2E/support/config/roles.ts"],
                },
            }
        ),
        encoding="utf-8",
    )
    written = set(materialize_mined_auth_artifacts(tmp_path))
    assert "admin" in written
    assert "head" in written
    assert "staff" not in written
    head = json.loads(
        (tmp_path / ".ai-test" / "auth" / "head.json").read_text(encoding="utf-8")
    )
    assert head["username"] == "head_c09a"
    assert head["password"] == "user"


def test_materialize_without_profile_roles_keeps_primary_only(tmp_path: Path):
    (tmp_path / ".yo-rc.json").write_text("{}", encoding="utf-8")
    written = materialize_mined_auth_artifacts(tmp_path)
    assert "admin" in written
    assert "default" in written
    assert "staff" not in written
    assert not (tmp_path / ".ai-test" / "auth" / "staff.json").is_file()


def test_materialize_writes_auth_artifacts(tmp_path: Path):
    (tmp_path / ".yo-rc.json").write_text("{}", encoding="utf-8")
    written = materialize_mined_auth_artifacts(tmp_path)
    assert "admin" in written
    assert (tmp_path / ".ai-test" / "auth" / "admin.json").is_file()
    d = discover_project_auth(str(tmp_path))
    assert d.is_ready()
    admin = d.pick("admin")
    assert admin is not None
    assert admin.username == "admin"


def test_auth_env_exports_all_roles(tmp_path: Path):
    (tmp_path / ".env").write_text(
        "E2E_ADMIN_USERNAME=admin\n"
        "E2E_ADMIN_PASSWORD=admin\n"
        "E2E_INVESTIGATOR_USERNAME=investigator\n"
        "E2E_INVESTIGATOR_PASSWORD=investigator\n",
        encoding="utf-8",
    )
    d = discover_project_auth(str(tmp_path), preferred_role="investigator")
    env = auth_env_for_role(d, "investigator")
    assert env["E2E_USERNAME"] == "investigator"
    assert env["E2E_ROLE"] == "investigator"
    assert env["E2E_ADMIN_USERNAME"] == "admin"
    assert env["E2E_INVESTIGATOR_USERNAME"] == "investigator"


def test_parse_roles_list_multi():
    roles = parse_roles_list(
        "authRole: investigator\nroles: admin, investigator, director\n",
        "Đăng nhập với nhiều role",
    )
    assert roles[0] == "investigator"
    assert "admin" in roles
    assert "director" in roles
