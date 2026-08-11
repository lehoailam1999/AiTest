"""Phase 0 — Rule Index governance artifacts exist."""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DOCS = REPO / "docs"
CURSOR_RULE = REPO / ".cursor" / "rules" / "rule-index.mdc"
REGISTRY = REPO / "api" / "app" / "rules" / "rule_registry.yaml"


def test_phase0_deliverables_exist():
    assert (DOCS / "SYSTEM_MASTER_DOCUMENTATION.md").is_file()
    assert CURSOR_RULE.is_file()
    assert REGISTRY.is_file()
    assert (REPO / "api" / "app" / "rules" / "README.md").is_file()
    assert (REPO / "desktop" / "src" / "lib" / "ruleIndex" / "README.md").is_file()
