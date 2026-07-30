"""Unit tests for snapshot → prompt (docs + Knowledge + existing TCs)."""

from app.features.requirement_studio.snapshot_prompt import (
    build_freeze_bundle,
    module_scoped_snapshot_prompt,
    slice_freeze_content_for_module,
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


def test_freeze_prompt_dedup_helpers():
    from app.features.requirement_studio.snapshot_prompt import (
        freeze_prompt_has_existing_tcs,
        freeze_prompt_has_knowledge,
        strip_freeze_existing_tcs_section,
    )

    text = snapshot_payload_to_prompt(
        title="X",
        summary="s",
        payload=build_freeze_bundle(
            knowledge_payload={"features": [{"name": "A", "description": "d"}]},
            knowledge_summary="s",
            uploaded_files=[],
            chat_transcript=[{"role": "user", "content": "hi"}],
            existing_test_cases=[{"title": "TC1", "type": "Unit"}],
        ),
        knowledge_version=1,
    )
    assert freeze_prompt_has_knowledge(text)
    assert freeze_prompt_has_existing_tcs(text)
    stripped = strip_freeze_existing_tcs_section(text)
    assert "TC1" not in stripped
    assert "Knowledge workspace" in stripped
    assert "hi" in stripped

def test_module_scoped_freeze_is_slimmer_than_full():
    huge_doc = "x" * 20_000
    bundle = build_freeze_bundle(
        knowledge_payload={
            "features": [
                {"name": "Login", "description": "Auth flow"},
                {"name": "Todos", "description": "CRUD"},
            ],
            "useCases": [
                {"name": "Login happy", "steps": "1. Open\n2. Submit"},
                {"name": "Create todo", "steps": "1. Add"},
            ],
            "businessRules": [{"id": "BR1", "text": "Login max 5 attempts"}],
            "validationRules": [{"field": "email", "rule": "required"}],
            "acceptanceCriteria": [{"text": "User reaches dashboard after Login"}],
            "gaps": [],
        },
        knowledge_summary="App with Login and Todos",
        uploaded_files=[{"fileName": "big.md", "text": huge_doc}],
        chat_transcript=[],
        existing_test_cases=[{"title": "Old", "type": "E2E"}],
    )
    full = snapshot_payload_to_prompt(
        title="App", summary="App", payload=bundle, knowledge_version=2
    )
    slim = module_scoped_snapshot_prompt(
        title="App",
        summary="App",
        payload=bundle,
        knowledge_version=2,
        module="Login",
        soft_max=12_000,
    )
    assert "Login" in slim
    assert len(slim) < len(full)
    assert len(slim) <= 12_000
    # Fan-out skips full uploaded docs
    assert huge_doc[:100] not in slim


def test_slice_freeze_content_uses_payload_when_present():
    bundle = build_freeze_bundle(
        knowledge_payload={
            "features": [{"name": "Reports", "description": "Export"}],
            "useCases": [{"name": "Export PDF", "steps": "1. Click"}],
        },
        knowledge_summary="Reports",
        uploaded_files=[{"fileName": "a.md", "text": "noise " * 5000}],
        chat_transcript=[],
        existing_test_cases=[],
    )
    out = slice_freeze_content_for_module(
        "ignored full text",
        "Reports",
        soft_max=8_000,
        snap_payload=bundle,
        title="R",
        summary="Reports",
        knowledge_version=1,
    )
    assert "Reports" in out
    assert "Export" in out or "PDF" in out
