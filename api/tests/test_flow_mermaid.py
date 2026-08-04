"""BUSINESS_FLOWS Mermaid dual-field — no break to steps/TC contract."""

from __future__ import annotations

from app.features.requirement_studio.flow_mermaid import (
    enrich_use_case_flow_fields,
    extract_steps_from_mermaid,
    sanitize_flow_mermaid,
    steps_to_linear_mermaid,
)
from app.features.requirement_studio.knowledge_builder import normalize_knowledge_payload


def test_sanitize_accepts_flowchart_strips_fence():
    raw = "```mermaid\nflowchart TD\n  A[Login] --> B[Home]\n```"
    out = sanitize_flow_mermaid(raw)
    assert out.startswith("flowchart TD")
    assert "```" not in out
    assert sanitize_flow_mermaid("just prose") == ""


def test_steps_to_mermaid_professional_style():
    steps = "1. Mở form\n2. Nhập email\n3. Nhấn Đăng nhập\n3. Nhấn Đăng nhập"
    mmd = steps_to_linear_mermaid(steps, name="Đăng nhập")
    assert "flowchart TD" in mmd
    assert "classDef startEnd" in mmd
    assert ":::action" in mmd
    assert "%%" not in mmd
    # No duplicate node for repeated step
    assert mmd.count("Nhấn Đăng nhập") == 1
    # Name not echoed as a node
    assert "[Đăng nhập]" not in mmd or mmd.count("Đăng nhập") <= 2


def test_enrich_strips_redundant_name_from_steps():
    row = enrich_use_case_flow_fields(
        {
            "name": "Đăng nhập",
            "steps": "1. Đăng nhập\n2. Mở form\n3. Nhập email\n4. Submit",
        }
    )
    assert "1. Mở form" in row["steps"]
    assert not row["steps"].splitlines()[0].endswith("Đăng nhập") or "Mở form" in row["steps"]
    assert "classDef" in row["mermaid"]


def test_enrich_mermaid_only_fills_steps():
    row = enrich_use_case_flow_fields(
        {
            "name": "Login",
            "mermaid": "flowchart TD\n  A[Mở form] --> B[Submit]",
        }
    )
    assert row["name"] == "Login"
    assert "mermaid" in row
    assert "1." in row["steps"]
    assert "Mở form" in row["steps"]


def test_enrich_steps_only_fills_mermaid():
    row = enrich_use_case_flow_fields(
        {"name": "Login", "steps": "1. A\n2. B"}
    )
    assert row["steps"].startswith("1.")
    assert "flowchart TD" in row["mermaid"]


def test_hollow_exception_flow_dropped():
    from app.features.requirement_studio.flow_mermaid import is_hollow_use_case

    assert is_hollow_use_case("Luồng ngoại lệ (Exception Flow)", "Luồng ngoại lệ (Exception Flow)")
    assert is_hollow_use_case(
        "thiếu điều kiện kích hoạt + phản hồi quan sát được (status|message|hành vi UI/API) cho exceptions",
        "thiếu điều kiện kích hoạt + phản hồi quan sát được",
    )
    assert is_hollow_use_case(
        "X",
        "Luồng ngoại lệ (Exception Flow) được khai báo nhưng trống — thiếu điều kiện kích hoạt",
    )


def test_normalize_drops_hollow_exception_flow_uc_and_shortens_gap():
    payload = normalize_knowledge_payload(
        {
            "useCases": [
                {
                    "name": "Luồng ngoại lệ (Exception Flow)",
                    "steps": "Luồng ngoại lệ (Exception Flow)",
                },
                {
                    "name": "thiếu điều kiện kích hoạt + phản hồi quan sát được (status|message) cho exceptions",
                    "steps": (
                        "Luồng ngoại lệ (Exception Flow) được khai báo nhưng trống — "
                        "thiếu điều kiện kích hoạt + phản hồi quan sát được"
                    ),
                    "mermaid": (
                        "flowchart TD\n"
                        "  S([Bắt đầu])\n"
                        "  N1[thiếu điều kiện kích hoạt]\n"
                        "  S --> N1\n"
                        "  E([Kết thúc])\n"
                        "  N1 --> E"
                    ),
                },
                {
                    "name": "Đăng nhập",
                    "steps": "1. Mở form\n2. Nhập email\n3. Submit",
                },
            ],
            "exceptions": [
                {
                    "text": (
                        "thiếu điều kiện kích hoạt + phản hồi quan sát được "
                        "(status|message|hành vi UI/API) cho exceptions"
                    )
                }
            ],
            "gaps": [],
        }
    )
    names = [u["name"] for u in payload["useCases"]]
    assert names == ["Đăng nhập"]
    assert "flowchart" in (payload["useCases"][0].get("mermaid") or "")
    assert payload["exceptions"] == []
    gap_texts = [g["text"] for g in payload["gaps"]]
    assert any("Exception Flow" in t or "ngoại lệ" in t for t in gap_texts)
    assert all(len(t) < 200 for t in gap_texts)


def test_normalize_preserves_steps_for_legacy_and_adds_mermaid():
    payload = normalize_knowledge_payload(
        {
            "summary": "x",
            "useCases": [
                {"name": "UC Login", "steps": "1. Mở trang\n2. Đăng nhập"},
            ],
        }
    )
    uc = payload["useCases"][0]
    assert uc["steps"].startswith("1.")
    assert "flowchart" in (uc.get("mermaid") or "")


def test_normalize_mermaid_only_still_has_steps_for_tc():
    payload = normalize_knowledge_payload(
        {
            "useCases": [
                {
                    "name": "UC Register",
                    "mermaid": (
                        "flowchart TD\n"
                        "  A[Mở form đăng ký] --> B[Nhập họ tên]\n"
                        "  B --> C[Lưu]"
                    ),
                }
            ],
        }
    )
    uc = payload["useCases"][0]
    assert uc["steps"]
    assert "1." in uc["steps"]
    assert "Nhập" in uc["steps"] or "Lưu" in uc["steps"] or "form" in uc["steps"].lower()
    # Freeze/TC still see steps field
    assert "mermaid" in uc
