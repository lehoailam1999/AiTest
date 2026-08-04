"""Step 3 — resolve storageState for Inspect when Desktop sends TC-cwd relative path."""

from __future__ import annotations

import json
from pathlib import Path

from app.services.e2e_auth_bootstrap import resolve_storage_state_abs


def _valid_state() -> str:
    return json.dumps(
        {
            "cookies": [{"name": "sid", "value": "1", "domain": "localhost", "path": "/"}],
            "origins": [],
        }
    )


def test_resolve_direct_rel_under_project(tmp_path: Path):
    f = tmp_path / "fixtures" / "storageState.json"
    f.parent.mkdir(parents=True)
    f.write_text(_valid_state(), encoding="utf-8")
    abs_path = resolve_storage_state_abs(
        str(tmp_path), storage_state_rel="./fixtures/storageState.json"
    )
    assert abs_path
    assert Path(abs_path).is_file()


def test_resolve_falls_back_to_aitest_module_fixtures(tmp_path: Path):
    # Desktop sends ./fixtures/... but file only exists under AItest
    nested = (
        tmp_path
        / "AItest"
        / "E2ETest"
        / "Owners"
        / "fixtures"
        / "storageState.json"
    )
    nested.parent.mkdir(parents=True)
    nested.write_text(_valid_state(), encoding="utf-8")
    abs_path = resolve_storage_state_abs(
        str(tmp_path),
        storage_state_rel="./fixtures/storageState.json",
        module="Owners",
    )
    assert abs_path
    assert Path(abs_path).resolve() == nested.resolve()


def test_resolve_broader_scan_without_module(tmp_path: Path):
    nested = (
        tmp_path
        / "AItest"
        / "E2ETest"
        / "SomeMod"
        / "fixtures"
        / "storageState.json"
    )
    nested.parent.mkdir(parents=True)
    nested.write_text(_valid_state(), encoding="utf-8")
    abs_path = resolve_storage_state_abs(
        str(tmp_path),
        storage_state_rel="./fixtures/storageState.json",
    )
    assert abs_path
    assert Path(abs_path).resolve() == nested.resolve()


def test_resolve_rejects_empty_json(tmp_path: Path):
    f = tmp_path / "fixtures" / "storageState.json"
    f.parent.mkdir(parents=True)
    f.write_text("{}", encoding="utf-8")
    assert (
        resolve_storage_state_abs(
            str(tmp_path), storage_state_rel="./fixtures/storageState.json"
        )
        == ""
    )
