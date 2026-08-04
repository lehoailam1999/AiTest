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
