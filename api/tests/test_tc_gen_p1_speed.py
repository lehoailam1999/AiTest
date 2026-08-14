"""P1 TC gen speed: E2E fast-by-default, soft ceiling on fast, slim rules."""

from __future__ import annotations

import os
from unittest import mock

from app.llm.base import GenerateContext, system_prompt, tc_module_gen_user_prompt, tc_seed_prompt
from app.llm.tc_generation_rules import (
    E2E_SPEED_SHARED_TC_RULES,
    SPEED_SHARED_TC_RULES,
    engine_generation_rules,
    get_tc_generation_rules,
)
from app.llm.tc_speed import (
    knowledge_enough_skip_source_scan,
    resolve_max_tc_per_module,
    resolve_tc_speed_mode,
)


def test_e2e_speed_defaults_fast_with_soft_ceiling():
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_E2E_SPEED", None)
        os.environ.pop("AITEST_TC_E2E_MAX_PER_MODULE", None)
        os.environ.pop("AITEST_TC_E2E_FAST_MAX_PER_MODULE", None)
        assert resolve_tc_speed_mode("e2e", {}) == "fast"
        assert resolve_max_tc_per_module("e2e", "fast", {}) == 10
        assert resolve_max_tc_per_module("e2e", "full", {}) is None


def test_engine_hint_speed_and_max_override():
    assert resolve_tc_speed_mode("e2e", {"speed": "fast"}) == "fast"
    assert resolve_max_tc_per_module("e2e", "full", {}) is None
    assert resolve_max_tc_per_module("e2e", "fast", {"maxPerModule": 4}) == 4
    with mock.patch.dict(os.environ, {"AITEST_TC_E2E_MAX_PER_MODULE": "10"}, clear=False):
        assert resolve_max_tc_per_module("e2e", "full", {}) == 10
    with mock.patch.dict(
        os.environ, {"AITEST_TC_E2E_FAST_MAX_PER_MODULE": "0"}, clear=False
    ):
        assert resolve_max_tc_per_module("e2e", "fast", {}) is None


def test_knowledge_enough_skip_source_scan():
    rich = {
        "knowledge": {
            "features": [{"name": "Todo"}],
            "acceptanceCriteria": [{"id": "AC1"}, {"id": "AC2"}],
            "validationRules": [{"id": "V1"}],
            "businessRules": [],
            "actors": [{"name": "User"}],
        }
    }
    unit_rich = {
        "knowledge": {
            "features": [{"name": "Evidence"}],
            "businessRules": [{"id": "BR-1"}],
            "validationRules": [{"id": "VAL-1"}],
            "exceptions": [{"id": "EXC-1"}],
            "acceptanceCriteria": [{"id": "AC-1"}],
        }
    }
    assert knowledge_enough_skip_source_scan(rich, "e2e") is True
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_UNIT_SKIP_SOURCE_SCAN", None)
        os.environ.pop("AITEST_TC_UNIT_FORCE_SOURCE_SCAN", None)
        # Unit: skip when PRIMARY rich (analysis-first)
        assert knowledge_enough_skip_source_scan(unit_rich, "unit") is True
    thin = {"knowledge": {"features": [{"name": "X"}]}}
    assert knowledge_enough_skip_source_scan(thin, "e2e") is False
    assert knowledge_enough_skip_source_scan(thin, "unit") is False
    with mock.patch.dict(os.environ, {"AITEST_TC_E2E_FORCE_SOURCE_SCAN": "1"}, clear=False):
        assert knowledge_enough_skip_source_scan(rich, "e2e") is False
    with mock.patch.dict(os.environ, {"AITEST_TC_UNIT_FORCE_SOURCE_SCAN": "1"}, clear=False):
        assert knowledge_enough_skip_source_scan(unit_rich, "unit") is False
    with mock.patch.dict(os.environ, {"AITEST_TC_UNIT_SKIP_SOURCE_SCAN": "1"}, clear=False):
        assert knowledge_enough_skip_source_scan(thin, "unit") is True


def test_unit_fast_soft_ceiling_and_primary_rounds():
    from app.llm.tc_speed import (
        resolve_max_tc_per_module,
        resolve_unit_primary_retry_rounds,
    )

    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_UNIT_MAX_PER_MODULE", None)
        os.environ.pop("AITEST_TC_UNIT_FAST_MAX_PER_MODULE", None)
        os.environ.pop("AITEST_TC_UNIT_PRIMARY_RETRY_ROUNDS", None)
        assert resolve_max_tc_per_module("unit", "fast", {}) == 10
        assert resolve_max_tc_per_module("unit", "full", {}) is None
        assert resolve_unit_primary_retry_rounds("fast") == 0
        assert resolve_unit_primary_retry_rounds("full") == 2
    with mock.patch.dict(
        os.environ, {"AITEST_TC_UNIT_FAST_MAX_PER_MODULE": "0"}, clear=False
    ):
        assert resolve_max_tc_per_module("unit", "fast", {}) is None
    with mock.patch.dict(
        os.environ, {"AITEST_TC_UNIT_PRIMARY_RETRY_ROUNDS": "1"}, clear=False
    ):
        assert resolve_unit_primary_retry_rounds("fast") == 1



def test_slim_rules_when_speed_fast():
    shared = get_tc_generation_rules(preferred_engine="e2e", speed="fast")
    assert shared == E2E_SPEED_SHARED_TC_RULES.strip()
    assert "SPEED" in shared
    # Unit speed path unchanged (shared SPEED skeleton, not E2E-only format).
    assert get_tc_generation_rules(preferred_engine="unit", speed="fast") == SPEED_SHARED_TC_RULES.strip()
    e2e = engine_generation_rules("e2e", speed="fast", max_per_module=None)
    assert "PHIÊN SINH E2E (SPEED)" in e2e
    assert "không trần" in e2e.lower() or "cấm thừa" in e2e.lower() or "Cover đủ" in e2e
    assert len(e2e) < len(engine_generation_rules("e2e", speed="full"))


def test_system_prompt_e2e_no_numeric_ceiling():
    p = system_prompt(
        GenerateContext(
            preferred_engine="e2e",
            speed_mode="fast",
            max_tc_per_module=None,
            feature_titles=["Auth"],
            topic_scope="**Auth**",
        )
    )
    assert "không trần số TC cố định" in p or "KHÔNG trần số lượng" in p
    assert "E2E COVERAGE" in p
    assert "tối đa ~6" not in p


def test_module_gen_prompt_e2e_full_coverage():
    gen = tc_module_gen_user_prompt(
        "Req",
        "FR login",
        GenerateContext(
            feature_titles=["Auth"],
            preferred_engine="e2e",
            speed_mode="fast",
            max_tc_per_module=None,
        ),
    )
    assert "KHÔNG trần số lượng" in gen
    assert "cấm TC thừa" in gen.lower() or "Cấm TC thừa" in gen
    assert "≤~6" not in gen


def test_seed_prompt_e2e_coverage():
    seed = tc_seed_prompt(
        GenerateContext(
            preferred_engine="e2e",
            speed_mode="fast",
            max_tc_per_module=None,
        )
    )
    assert "E2E COVERAGE" in seed or "không trần" in seed.lower()
    assert len(seed) < 5000
