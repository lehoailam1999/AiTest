"""Unit tests for snapshot → prompt (docs + Knowledge + existing TCs)."""

from app.features.requirement_studio.snapshot_prompt import (
    build_freeze_bundle,
    snapshot_payload_to_prompt,
)


def test_freeze_bundle_prompt_synthesizes_docs_knowledge_and_existing_tcs():
    bundle = build_freeze_bundle(
        knowledge_payload={
            "features": [{"name": "Todos", "description": "CRUD"}],
            "businessRules": [{"id": "BR1", "text": "Title max 200"}],
            "validationRules": [{"field": "title", "rule": "max 200"}],
            "apiSummary": [{"method": "POST", "path": "/todos", "note": "create"}],
            "exceptions": [{"text": "400 when title empty"}],
            "acceptanceCriteria": [{"text": "Given user When create Then 201"}],
            "gaps": [],
        },
        knowledge_summary="CRUD todos",
        uploaded_files=[{"fileName": "spec.md", "text": "POST /todos creates an item"}],
        chat_transcript=[
            {"role": "user", "content": "Thêm rule XSS"},
            {"role": "assistant", "content": "Đã thêm rule XSS vào Knowledge"},
        ],
        existing_test_cases=[
            {
                "title": "Tạo todo thành công",
                "type": "Chức năng",
                "module": "Todos",
                "priority": "Cao",
                "reviewStatus": "Approved",
            }
        ],
    )
    text = snapshot_payload_to_prompt(
        title="Todo Snapshot",
        summary="CRUD todos",
        payload=bundle,
        knowledge_version=4,
    )
    assert "Uploaded documents" in text
    assert "spec.md" in text
    assert "POST /todos creates an item" in text
    assert "Title max 200" in text
    assert "/todos" in text
    assert "Features" in text
    assert "Validation" in text
    assert "Acceptance" in text
    assert "Existing test cases" in text
    assert "Tạo todo thành công" in text
    assert "do not duplicate" in text.lower() or "fill gaps" in text.lower()
    assert "silently synthesize" in text.lower() or "synthesize" in text.lower()
    assert "Chat transcript" in text
    assert "Thêm rule XSS" in text


def test_freeze_bundle_without_existing_tcs_still_notes_inventory():
    bundle = build_freeze_bundle(
        knowledge_payload={"businessRules": [{"text": "Must login"}]},
        knowledge_summary="Auth",
        uploaded_files=[],
        chat_transcript=[],
        existing_test_cases=[],
    )
    text = snapshot_payload_to_prompt(
        title="Auth",
        summary="Auth",
        payload=bundle,
        knowledge_version=1,
    )
    assert "Existing test cases" in text
    assert "none yet" in text.lower()
    assert "Chat transcript" not in text


def test_legacy_knowledge_only_still_works():
    text = snapshot_payload_to_prompt(
        title="Legacy",
        summary="old",
        payload={"businessRules": [{"text": "Must login"}]},
        knowledge_version=1,
    )
    assert "Must login" in text
    assert "Knowledge workspace" in text
