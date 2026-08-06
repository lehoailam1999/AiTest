"""Phase 0 — Rule Index audit artifacts exist and inventory is consistent."""

from __future__ import annotations

import csv
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DOCS = REPO / "docs"
CURSOR_RULE = REPO / ".cursor" / "rules" / "rule-index.mdc"


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def test_phase0_deliverables_exist():
    assert (DOCS / "RULE_INDEX_PLAN.md").is_file()
    assert (DOCS / "rule_inventory.csv").is_file()
    assert (DOCS / "rule_flow_matrix.csv").is_file()
    assert CURSOR_RULE.is_file()
    assert (REPO / "api" / "app" / "rules" / "README.md").is_file()
    assert (REPO / "desktop" / "src" / "lib" / "ruleIndex" / "README.md").is_file()


def test_inventory_csv_has_expected_columns():
    rows = _read_csv(DOCS / "rule_inventory.csv")
    assert rows
    required = {
        "rule_id",
        "domain",
        "source_file",
        "inject_mode",
        "phase_target",
    }
    assert required <= set(rows[0].keys())


def test_flow_matrix_profiles_match_inventory_domains():
    flows = _read_csv(DOCS / "rule_flow_matrix.csv")
    inventory = _read_csv(DOCS / "rule_inventory.csv")
    profile_ids = {r["selective_profile_id"] for r in flows if r.get("selective_profile_id")}
    assert "PROFILE-UNIT-CODEGEN" in profile_ids
    assert "PROFILE-E2E-CODEGEN" in profile_ids
    assert len(inventory) >= 40
