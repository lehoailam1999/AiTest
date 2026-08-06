# -*- coding: utf-8 -*-
"""Regression: Todo SRS → 4 user features + 4 UCs with mermaid."""
from pathlib import Path

from app.features.requirement_studio.document_model import (
    build_document_index,
    index_to_chunk_pairs,
)
from app.features.requirement_studio.knowledge_builder import (
    _extract_main_flow_steps,
    build_knowledge_heuristic,
)


def test_merge_prefers_richer_use_case_over_hollow_llm():
    from app.features.requirement_studio.knowledge_builder import merge_knowledge_payloads

    base = {
        "summary": "H",
        "features": [{"name": "Xem danh sách", "description": "FR-01: GET /todos"}],
        "useCases": [
            {
                "name": "Xem danh sách công việc",
                "steps": "1. Mở trang\n2. Gọi API\n3. Hiển thị list",
                "mermaid": "flowchart TD\n  S([Bắt đầu]):::startEnd\n  N1[Mở trang]:::action\n  S --> N1",
            }
        ],
        "actors": [],
        "businessRules": [],
        "validationRules": [],
        "apiSummary": [],
        "exceptions": [],
        "acceptanceCriteria": [],
        "constraints": [],
        "gaps": [],
    }
    over = {
        "useCases": [
            {
                "name": "Xem danh sách công việc",
                "steps": "| Mục | Nội dung |\n| Luồng chính | … |",
                "mermaid": "",
            }
        ],
    }
    m = merge_knowledge_payloads(base, over)
    assert len(m["useCases"]) == 1
    assert "Mở trang" in (m["useCases"][0].get("steps") or "")
    assert "| Mục |" not in (m["useCases"][0].get("steps") or "")
    body = (
        "| Mục | Nội dung |\n|---|---|\n"
        "| Luồng chính | 1. Mở trang<br>2. Gọi API<br>3. Hiển thị danh sách |"
    )
    steps = _extract_main_flow_steps(body)
    assert "1. Mở trang" in steps
    assert "2. Gọi API" in steps
    assert "3. Hiển thị" in steps
    assert "|" not in steps


def test_todo_srs_features_and_flows_tight():
    path = Path(r"d:\Todo\SRS.md")
    if not path.is_file():
        import pytest

        pytest.skip("optional local fixture")
    text = path.read_text(encoding="utf-8")
    pairs = index_to_chunk_pairs(build_document_index(text, file_name="SRS.md"))
    out = build_knowledge_heuristic(pairs, file_names=["SRS.md"])
    names = [f["name"].lower() for f in out["features"]]
    assert len(out["features"]) == 4
    assert any("xem" in n for n in names)
    assert any("tạo" in n for n in names)
    assert not any("frontend" in n for n in names)
    assert not any("mã lỗi" in n or "thông báo lỗi" in n for n in names)
    assert len(out["useCases"]) == 4
    for uc in out["useCases"]:
        assert uc.get("mermaid"), f"missing mermaid for {uc.get('name')}"
        assert "flowchart" in (uc.get("mermaid") or "")
        assert "| Mục |" not in (uc.get("steps") or "")
        assert "| Mục |" not in (uc.get("mermaid") or "")
        assert (uc.get("steps") or "").count("\n") >= 1
