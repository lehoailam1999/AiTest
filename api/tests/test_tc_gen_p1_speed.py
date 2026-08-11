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
    assert knowledge_enough_skip_source_scan(rich, "e2e") is True
    # Unit: never skip just because Knowledge is rich
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_UNIT_SKIP_SOURCE_SCAN", None)
        assert knowledge_enough_skip_source_scan(rich, "unit") is False
    thin = {"knowledge": {"features": [{"name": "X"}]}}
    assert knowledge_enough_skip_source_scan(thin, "e2e") is False
    assert knowledge_enough_skip_source_scan(thin, "unit") is False
    with mock.patch.dict(os.environ, {"AITEST_TC_E2E_FORCE_SOURCE_SCAN": "1"}, clear=False):
        assert knowledge_enough_skip_source_scan(rich, "e2e") is False
    with mock.patch.dict(os.environ, {"AITEST_TC_UNIT_SKIP_SOURCE_SCAN": "1"}, clear=False):
        assert knowledge_enough_skip_source_scan(rich, "unit") is True


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
