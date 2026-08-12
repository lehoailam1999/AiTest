"""Phase A/B/C: slim freeze prompt, enrich hash, fan-out batch size."""

from __future__ import annotations

import os
from unittest import mock

from app.features.requirement_studio.knowledge_builder import chunks_input_hash
from app.features.requirement_studio.snapshot_prompt import (
    knowledge_rich_enough_to_omit_docs,
    slim_freeze_payload_for_tc_gen,
    snapshot_payload_to_prompt,
)
from app.llm.tc_speed import resolve_fanout_batch_size


def _rich_kw():
    return {
        "features": [{"name": "Login"}],
        "validationRules": [{"field": "email", "rule": "required"}],
        "businessRules": [{"id": "BR1", "text": "pwd min 8"}],
        "acceptanceCriteria": [{"text": "user can login"}],
        "apiSummary": [],
    }


def test_knowledge_rich_enough_to_omit_docs():
    assert knowledge_rich_enough_to_omit_docs(_rich_kw()) is True
    assert knowledge_rich_enough_to_omit_docs({"features": [{"name": "X"}]}) is False


def test_slim_freeze_omits_uploaded_files_when_rich():
    payload = {
        "schema": "freeze-bundle-v1",
        "knowledge": _rich_kw(),
        "knowledgeSummary": "Auth",
        "uploadedFiles": [
            {"name": "srs.md", "text": "A" * 5000},
        ],
        "chatTranscript": [{"role": "user", "content": "hi"}],
        "existingTestCases": [
            {
                "title": "Login ok",
                "type": "Unit",
                "module": "Login",
                "priority": "Cao",
                "steps": "1. login",
            }
        ],
    }
    slim = slim_freeze_payload_for_tc_gen(payload)
    assert slim["uploadedFiles"] == []
    assert slim["chatTranscript"] == []
    assert slim["existingTestCases"][0]["title"] == "Login ok"
    assert "steps" not in slim["existingTestCases"][0]

    full = snapshot_payload_to_prompt(
        title="Snap",
        summary="Auth",
        payload=payload,
        knowledge_version=1,
    )
    slim_text = snapshot_payload_to_prompt(
        title="Snap",
        summary="Auth",
        payload=payload,
        knowledge_version=1,
        omit_docs_when_rich=True,
        existing_titles_only=True,
    )
    assert len(slim_text) < len(full)
    assert "omitted — Knowledge" in slim_text or "AAAA" not in slim_text
    assert "AAAA" in full or "srs.md" in full


def test_chunks_input_hash_stable():
    pairs = [("H1", "body one"), (None, "body two")]
    names = ["a.md", "b.md"]
    assert chunks_input_hash(pairs, names) == chunks_input_hash(pairs, names)
    assert chunks_input_hash(pairs, names) != chunks_input_hash(pairs + [("X", "y")], names)


def test_resolve_fanout_batch_size_default_2():
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("AITEST_TC_FANOUT_BATCH_MODULES", None)
        os.environ.pop("AITEST_TC_FANOUT_BATCH_MODULES_CURSOR", None)
        assert resolve_fanout_batch_size(is_cursor=False) == 3
        assert resolve_fanout_batch_size(is_cursor=True) == 3
        os.environ["AITEST_TC_FANOUT_BATCH_MODULES_CURSOR"] = "3"
        assert resolve_fanout_batch_size(is_cursor=True) == 3
        os.environ["AITEST_TC_FANOUT_BATCH_MODULES"] = "1"
        assert resolve_fanout_batch_size(is_cursor=False) == 1
        os.environ["AITEST_TC_FANOUT_BATCH_MODULES_CURSOR"] = "99"
        assert resolve_fanout_batch_size(is_cursor=True) == 4
