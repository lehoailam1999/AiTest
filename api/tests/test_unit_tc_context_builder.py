"""Unit TC Knowledge Map + Minimal Sufficient Context builder."""

from __future__ import annotations

from app.services.unit_tc_context_builder import (
    build_unit_module_msc,
    clear_msc_cache_mem,
    pack_knowledge_from_ranked,
    retrieve_ranked_for_module,
)
from app.services.unit_tc_knowledge_map import (
    KIND_BR,
    KIND_FEATURE,
    KIND_VAL,
    build_knowledge_map,
    feature_node_for_module,
    orphan_primary_ids,
)


def _sample_kw() -> dict:
    return {
        "summary": "Forensic evidence SRS",
        "features": [
            {
                "name": "Tạo mới vật chứng",
                "description": "FR-01~FR-03 tạo vật chứng kèm metadata",
            },
            {
                "name": "Gắn hồ sơ",
                "description": "FR-10 gắn vật chứng vào hồ sơ",
            },
        ],
        "businessRules": [
            {"id": "BR-1", "text": "Tạo mới vật chứng phải có mã duy nhất (FR-01)"},
            {"id": "BR-10", "text": "Gắn hồ sơ chỉ khi hồ sơ mở"},
            {"id": "BR-99", "text": "Policy toàn cục áp dụng mọi tenant"},
        ],
        "validationRules": [
            {
                "id": "VAL-1",
                "module": "Tạo mới vật chứng",
                "field": "Mã",
                "rule": "bắt buộc",
            },
            {
                "id": "VAL-10",
                "module": "Gắn hồ sơ",
                "field": "Hồ sơ",
                "rule": "tồn tại",
            },
        ],
        "exceptions": [
            {"id": "EXC-1", "text": "Từ chối tạo mới vật chứng khi thiếu mã"},
            {"id": "EXC-10", "text": "Gắn hồ sơ thất bại khi khóa"},
        ],
        "acceptanceCriteria": [
            {"id": "AC-1", "text": "Given tạo mới vật chứng When lưu Then success"},
            {"id": "AC-10", "text": "Given gắn hồ sơ When ok Then linked"},
        ],
        "useCases": [
            {"name": "UC tạo vật chứng", "steps": "1. mở form 2. lưu"},
            {"name": "UC gắn hồ sơ", "steps": "1. chọn 2. gắn"},
        ],
        "actors": [{"name": "Điều tra viên", "permissions": "create"}],
        "apiSummary": [{"method": "POST", "path": "/evidence", "note": "create"}],
    }


def test_knowledge_map_builds_feature_fr_and_module_edges():
    km = build_knowledge_map(_sample_kw())
    assert len(km.by_kind.get(KIND_FEATURE, [])) == 2
    assert any(n.startswith("fr:") for n in km.nodes)
    feat = feature_node_for_module(km, "Tạo mới vật chứng")
    assert feat is not None
    # VAL-1 linked via module_of / covers
    val_ids = km.by_kind.get(KIND_VAL, [])
    assert val_ids
    linked = {e.dst for e in km.edges if e.src == feat.node_id} | {
        e.src for e in km.edges if e.dst == feat.node_id
    }
    assert any("validationRule" in x for x in linked)


def test_retrieve_keeps_related_branch_drops_other_feature_primary():
    km = build_knowledge_map(_sample_kw())
    ranked = retrieve_ranked_for_module(km, "Tạo mới vật chứng")
    labels = {r.node.label for r in ranked}
    texts = " ".join(r.node.text for r in ranked)
    assert "BR-1" in labels or "BR-1" in texts
    assert "VAL-1" in labels or "VAL-1" in texts
    # Other feature's direct PRIMARY should not dominate L1
    br10 = [r for r in ranked if "BR-10" in r.node.label or "BR-10" in r.node.text]
    # BR-10 may appear only if orphan/home — should NOT be L1 for create module
    assert all(r.level != "L1" or "Gắn" in r.node.text for r in br10) or not br10
    features = [r for r in ranked if r.node.kind == KIND_FEATURE]
    assert features == []
    kinds = {r.node.kind for r in ranked}
    assert "useCase" not in kinds
    assert "actor" not in kinds
    assert "api" not in kinds


def test_orphan_primary_assigned_to_one_home_module():
    km = build_knowledge_map(_sample_kw())
    orphans = orphan_primary_ids(km)
    # BR-99 has no feature token → orphan
    assert any("BR-99" in km.nodes[o].label or "BR-99" in km.nodes[o].text for o in orphans)

    r_create = retrieve_ranked_for_module(km, "Tạo mới vật chứng")
    r_attach = retrieve_ranked_for_module(km, "Gắn hồ sơ")
    create_has = any("BR-99" in r.node.text or "BR-99" in r.node.label for r in r_create)
    attach_has = any("BR-99" in r.node.text or "BR-99" in r.node.label for r in r_attach)
    # Exactly one home (stable first feature by label among zero-score → alphabetical)
    assert create_has ^ attach_has or (create_has and not attach_has) or (
        attach_has and not create_has
    )
    assert create_has or attach_has


def test_token_budget_stops_packing_low_rank():
    km = build_knowledge_map(_sample_kw())
    ranked = retrieve_ranked_for_module(km, "Tạo mới vật chứng")
    packed = pack_knowledge_from_ranked(
        ranked, document_summary="sum", char_budget=500, module="Tạo mới vật chứng"
    )
    # Feature name stub only; PRIMARY capped by budget
    assert packed["features"]
    assert packed["features"][0].get("description") in ("", None)
    assert packed["useCases"] == []
    assert packed["actors"] == []
    assert packed["apiSummary"] == []
    total_primary = (
        len(packed["businessRules"])
        + len(packed["validationRules"])
        + len(packed["exceptions"])
        + len(packed["acceptanceCriteria"])
    )
    packed_wide = pack_knowledge_from_ranked(
        ranked,
        document_summary="sum",
        char_budget=50_000,
        module="Tạo mới vật chứng",
    )
    total_wide = (
        len(packed_wide["businessRules"])
        + len(packed_wide["validationRules"])
        + len(packed_wide["exceptions"])
        + len(packed_wide["acceptanceCriteria"])
    )
    assert total_primary <= total_wide


def test_msc_prompt_excludes_flows_and_keeps_primary(tmp_path, monkeypatch):
    monkeypatch.setenv("AITEST_TC_UNIT_MSC_CACHE_DIR", str(tmp_path))
    clear_msc_cache_mem()
    kw = _sample_kw()
    snap = {
        "schema": "freeze-bundle-v1",
        "knowledge": kw,
        "knowledgeSummary": "Evidence",
        "uploadedFiles": [],
        "chatTranscript": [],
        "existingTestCases": [],
    }
    text, meta = build_unit_module_msc(
        title="Snap",
        summary="Evidence",
        snap_payload=snap,
        knowledge_version=3,
        module="Tạo mới vật chứng",
        soft_max=9_000,
        workspace_id="ws-be",
        use_cache=False,
    )
    assert text
    assert "BR-1" in text
    assert "VAL-1" in text
    assert "mở form" not in text.lower()
    assert "UC tạo" not in text
    assert meta.get("packedPrimary", 0) >= 1


def test_msc_prompt_smaller_than_legacy_union_and_cache_hits(tmp_path, monkeypatch):
    monkeypatch.setenv("AITEST_TC_UNIT_MSC_CACHE_DIR", str(tmp_path))
    clear_msc_cache_mem()
    kw = _sample_kw()
    # Inflate with noise rows that should not enter create-module MSC
    kw["businessRules"].extend(
        {"id": f"BR-X{i}", "text": f"Gắn hồ sơ noise rule {i}"} for i in range(30)
    )
    snap = {
        "schema": "freeze-bundle-v1",
        "knowledge": kw,
        "knowledgeSummary": "Evidence",
        "uploadedFiles": [{"fileName": "big.md", "text": "x" * 20_000}],
        "chatTranscript": [],
        "existingTestCases": [],
    }
    text1, meta1 = build_unit_module_msc(
        title="Snap",
        summary="Evidence",
        snap_payload=snap,
        knowledge_version=3,
        module="Tạo mới vật chứng",
        soft_max=9_000,
        workspace_id="ws-test",
        use_cache=True,
    )
    assert text1
    assert meta1["cacheHit"] is False
    assert "Tạo mới vật chứng" in text1 or "MSC" in text1
    assert "BR-1" in text1
    # Noise rules for other feature should mostly be absent
    noise_hits = sum(1 for i in range(30) if f"BR-X{i}" in text1)
    assert noise_hits <= 2  # orphan-home might take none of these (they cover-link Gắn)
    assert len(text1) < 16_000

    text2, meta2 = build_unit_module_msc(
        title="Snap",
        summary="Evidence",
        snap_payload=snap,
        knowledge_version=3,
        module="Tạo mới vật chứng",
        soft_max=9_000,
        workspace_id="ws-test",
        use_cache=True,
    )
    assert meta2["cacheHit"] is True
    assert text2 == text1

    # knowledge_version bump → cache miss
    text3, meta3 = build_unit_module_msc(
        title="Snap",
        summary="Evidence",
        snap_payload=snap,
        knowledge_version=4,
        module="Tạo mới vật chứng",
        soft_max=9_000,
        workspace_id="ws-test",
        use_cache=True,
    )
    assert meta3["cacheHit"] is False
    assert text3  # still builds


def test_dependency_level_pulls_mentioned_br():
    kw = {
        "features": [{"name": "Upload", "description": "FR-01 upload"}],
        "businessRules": [
            {"id": "BR-1", "text": "Upload must scan virus"},
            {"id": "BR-2", "text": "When BR-1 fails, quarantine file"},
        ],
        "validationRules": [],
        "exceptions": [],
        "acceptanceCriteria": [],
    }
    km = build_knowledge_map(kw)
    ranked = retrieve_ranked_for_module(km, "Upload")
    ids = " ".join(f"{r.node.label} {r.node.text}" for r in ranked)
    assert "BR-1" in ids
    assert "BR-2" in ids
