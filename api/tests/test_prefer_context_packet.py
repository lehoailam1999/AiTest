"""P4 — packet + workspaceId → always use packet content (no workspace expand)."""

from __future__ import annotations

from app.services.generate_source_resolve import (
    packet_is_usable,
    resolve_from_context_packet,
)
from app.services.test_output_layout import under_generated_test_folder


def _angular_packet() -> dict:
    return {
        "packetVersion": 1,
        "purpose": "generate-unit",
        "meta": {"language": "TypeScript", "module": "Forensic", "testKind": "unit"},
        "testingStack": {
            "testingFramework": "jest",
            "mockFramework": "jest.mock",
            "assertionLibrary": "expect",
        },
        "sourceUnderTest": {
            "pathRel": (
                "Forensic/ClientApp/src/app/admin/case-record/update/"
                "evidence-update-modal.component.ts"
            ),
            "symbol": "EvidenceUpdateModalComponent",
            "methods": ["ngOnInit"],
            "constructorDeps": ["svc: CaseRecordService"],
        },
        "unitStrategy": {
            "whatToMock": ["CaseRecordService"],
            "forbidden": ["invent APIs", "Do not mirror ClientApp/src/app trees into tests"],
        },
        "files": [
            {
                "pathRel": (
                    "Forensic/ClientApp/src/app/admin/case-record/update/"
                    "evidence-update-modal.component.ts"
                ),
                "role": "primary",
                "content": (
                    "export class EvidenceUpdateModalComponent {\n"
                    "  constructor(private svc: CaseRecordService) {}\n"
                    "  ngOnInit() {}\n"
                    "}\n"
                ),
            },
            {
                "pathRel": (
                    "Forensic/ClientApp/src/app/admin/case-record/update/"
                    "case-record.service.ts"
                ),
                "role": "dependency",
                "why": "IDE constructor: CaseRecordService",
                "content": "export class CaseRecordService { get() {} }\n",
            },
        ],
        "diagnostics": {"truncated": [], "omittedPaths": [], "gaps": []},
    }


def test_packet_is_usable():
    assert packet_is_usable(_angular_packet()) is True
    assert packet_is_usable({"packetVersion": 1, "files": []}) is False
    assert packet_is_usable(None) is False


def test_p4_packet_plus_workspace_id_uses_packet_content():
    """DoD: packet + workspaceId → dùng packet content (không disk expand)."""
    packet = _angular_packet()
    workspace_marker = "WORKSPACE_DISK_CONTENT_SHOULD_NOT_APPEAR"
    body_stale = "STALE_BODY_SOURCE_CODE"

    resolved = resolve_from_context_packet(
        packet,
        workspace_id="ws-fake-should-be-ignored",
        body_source_code=body_stale,
        body_source_file_name="wrong/path.ts",
    )

    assert resolved.source_mode == "packet"
    assert resolved.ignored_workspace_id is True
    assert resolved.ignored_body_source_code is True
    assert "EvidenceUpdateModalComponent" in resolved.source_code
    assert workspace_marker not in resolved.source_code
    assert body_stale not in resolved.source_code
    assert "evidence-update-modal.component.ts" in resolved.source_file_name
    assert any("case-record.service.ts" in p for p, _ in resolved.related_sources)
    # Simulate route: never call resolve_generate_scope when packet usable
    assert packet_is_usable(packet)
    # workspaceId present in request but resolver did not need it
    assert "ignored_workspaceId=" in " ".join(resolved.notes)


def test_p4_packet_filename_hint_same_path_allowed():
    packet = _angular_packet()
    path = packet["files"][0]["pathRel"]
    resolved = resolve_from_context_packet(
        packet,
        body_source_file_name=path,
        body_source_code=packet["files"][0]["content"],
    )
    assert resolved.source_file_name == path
    assert resolved.ignored_body_source_code is False


def test_flat_aitest_path_with_tc_module():
    packet = _angular_packet()
    primary_path = packet["files"][0]["pathRel"]
    path = under_generated_test_folder(
        "unit",
        "evidence-update-modal.component.test.ts",
        source_file_name=primary_path,
        module="Forensic",
        package_prefix="",
    )
    assert path == "AItest/UnitTest/Forensic/evidence-update-modal.component.test.ts"
    assert "ClientApp" not in path
    assert "/src/" not in path
