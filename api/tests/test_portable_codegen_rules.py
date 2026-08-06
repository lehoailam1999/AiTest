"""Portable multi-project rules present in Unit/E2E SoT."""

from app.llm.e2e_codegen_rules import E2E_CODEGEN_SPEC, e2ecg_system_block
from app.llm.uutgs_rules import UUTGS_SPEC, uutgs_system_block


def test_uutgs_has_portable_section():
    assert "Portable across ANY project" in UUTGS_SPEC
    assert "NEVER assume" in UUTGS_SPEC or "NEVER invent" in UUTGS_SPEC
    block = uutgs_system_block()
    assert "AItest/UnitTest" in block


def test_e2ecg_has_portable_section():
    assert "Portable across ANY project" in E2E_CODEGEN_SPEC
    assert "PROJECT-AGNOSTIC" in E2E_CODEGEN_SPEC
    assert "ContextMissing" in E2E_CODEGEN_SPEC
    block = e2ecg_system_block()
    assert "Playwright" in block or "E2ECG" in block
