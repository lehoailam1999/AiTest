"""Serialize Freeze Snapshot → prompt for Generate TC.

Hidden synthesis before output: uploaded documents + Knowledge (Phân tích)
+ existing test cases (avoid duplicates, fill gaps).
Chat transcript is optional enrichment only when present in the bundle.
"""

from __future__ import annotations

import json
from typing import Any


def _as_list(value: Any) -> list:
    return value if isinstance(value, list) else []


def coerce_summary_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n".join(str(x).strip() for x in value if str(x).strip()).strip()
    return str(value).strip()


def _line_items(label: str, rows: list, *, fields: tuple[str, ...]) -> list[str]:
    if not rows:
        return []
    out = [f"## {label}"]
    for i, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            out.append(f"{i}. {row}")
            continue
        parts = []
        for f in fields:
            v = row.get(f)
            if v is not None and str(v).strip():
                parts.append(str(v).strip())
        if parts:
            out.append(f"{i}. " + " — ".join(parts))
    return out


def _knowledge_sections(p: dict) -> list[str]:
    lines: list[str] = []
    if p.get("documentSummary"):
        lines.extend(["", "### Document summary", str(p["documentSummary"]).strip()])
    lines.extend(
        _line_items(
            "Features",
            _as_list(p.get("features")),
            fields=("name", "description"),
        )
    )
    lines.extend(
        _line_items(
            "Actors & permissions",
            _as_list(p.get("actors")),
            fields=("name", "description", "permissions"),
        )
    )
    lines.extend(
        _line_items("Use cases / flows", _as_list(p.get("useCases")), fields=("name", "steps"))
    )
    lines.extend(
        _line_items(
            "Business rules",
            _as_list(p.get("businessRules")),
            fields=("id", "text", "priority"),
        )
    )
    lines.extend(
        _line_items(
            "Validation & data",
            _as_list(p.get("validationRules")),
            fields=("field", "rule"),
        )
    )
    lines.extend(
        _line_items(
            "API / interface",
            _as_list(p.get("apiSummary")),
            fields=("method", "path", "note"),
        )
    )
    lines.extend(
        _line_items("Exceptions / errors", _as_list(p.get("exceptions")), fields=("text",))
    )
    lines.extend(
        _line_items(
            "Acceptance criteria",
            _as_list(p.get("acceptanceCriteria")),
            fields=("text",),
        )
    )
    lines.extend(
        _line_items("NFR constraints", _as_list(p.get("constraints")), fields=("text",))
    )
    gaps = _as_list(p.get("gaps"))
    if not gaps:
        # Legacy snapshots
        gaps = _as_list(p.get("openQuestions")) + _as_list(p.get("missingInformation"))
    lines.extend(_line_items("Gaps (missing / TBD)", gaps, fields=("text",)))
    return lines


def _files_section(files: list) -> list[str]:
    if not files:
        return ["", "## Uploaded documents", "(no extracted text)"]
    out = ["", "## Uploaded documents"]
    for i, f in enumerate(files, 1):
        if not isinstance(f, dict):
            continue
        name = f.get("fileName") or f.get("name") or f"file-{i}"
        text = str(f.get("text") or "").strip()
        out.append(f"### File {i}: {name}")
        out.append(text if text else "(empty)")
    return out


def _chat_section(messages: list) -> list[str]:
    if not messages:
        return []
    out = ["", "## Chat transcript (optional enrichment)"]
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "user").upper()
        content = str(m.get("content") or "").strip()
        if not content:
            continue
        out.append(f"[{role}]")
        out.append(content)
        out.append("")
    return out


def _existing_tcs_section(cases: list) -> list[str]:
    if not cases:
        return [
            "",
            "## Existing test cases",
            "(none yet — generate a complete set from documents + Knowledge)",
        ]
    out = [
        "",
        "## Existing test cases (inventory — do not duplicate; fill gaps only)",
        f"Count: {len(cases)}. Prefer new coverage for rules/flows not listed below.",
    ]
    for i, row in enumerate(cases, 1):
        if not isinstance(row, dict):
            out.append(f"{i}. {row}")
            continue
        title = str(row.get("title") or "").strip() or f"TC-{i}"
        typ = str(row.get("type") or "").strip()
        module = str(row.get("module") or "").strip()
        priority = str(row.get("priority") or "").strip()
        status = str(row.get("reviewStatus") or "").strip()
        bits = [title]
        if typ:
            bits.append(typ)
        if module:
            bits.append(f"module={module}")
        if priority:
            bits.append(f"priority={priority}")
        if status:
            bits.append(f"status={status}")
        out.append(f"{i}. " + " · ".join(bits))
    return out


def snapshot_payload_to_prompt(
    *,
    title: str,
    summary: str | None,
    payload: dict | None,
    coverage: dict | None = None,  # kept for backward compat; unused in UI
    knowledge_version: int,
) -> str:
    """
    Build LLM input from Freeze bundle (hidden synthesis).
    Always merge: documents + Knowledge + existing TC inventory → accurate output.
    """
    del coverage
    p = payload or {}
    lines: list[str] = [
        f"# {title or 'Requirement Snapshot'}",
        f"Knowledge version: {knowledge_version}",
        "",
        "You are a senior QA engineer. Before emitting test cases, silently synthesize:",
        "1) uploaded requirement documents,",
        "2) structured Knowledge (Phân tích),",
        "3) existing test cases already in this workspace (if any).",
        "Then output an accurate, non-duplicative set of test cases.",
        "",
        "Rules:",
        "- Merge document details + Knowledge (rules, actors, use cases, APIs, constraints).",
        "- Cross-check the existing TC inventory: do not duplicate titles or paraphrase lightly.",
        "- Fill coverage gaps (happy path, negative/validation, auth, edge, key business rules).",
        "- When Knowledge lists use cases or APIs, ensure matching cases exist for each major flow.",
        "- If chat transcript is present, treat it as clarifications only.",
        "- Do not invent APIs or fields that contradict the documents/Knowledge.",
    ]

    if p.get("schema") == "freeze-bundle-v1":
        kw = p.get("knowledge") if isinstance(p.get("knowledge"), dict) else {}
        kw_summary = p.get("knowledgeSummary") or summary
        kw_text = coerce_summary_text(kw_summary)
        chat = _as_list(p.get("chatTranscript"))
        existing = _as_list(p.get("existingTestCases"))
        if kw_text:
            lines.extend(["", "## Knowledge summary", kw_text])
        lines.extend(_files_section(_as_list(p.get("uploadedFiles"))))
        lines.extend(["", "## Knowledge workspace (Phân tích)"])
        lines.extend(_knowledge_sections(kw))
        lines.extend(_existing_tcs_section(existing))
        lines.extend(_chat_section(chat))
    else:
        # Legacy snapshots (knowledge-only)
        if summary and coerce_summary_text(summary):
            lines.extend(["", "## Summary", coerce_summary_text(summary)])
        lines.extend(["", "## Knowledge workspace"])
        lines.extend(_knowledge_sections(p))
        lines.extend(_existing_tcs_section(_as_list(p.get("existingTestCases"))))

    text = "\n".join(lines).strip()
    if len(text) < 80:
        text = (
            f"# {title or 'Requirement Snapshot'}\n"
            f"Knowledge version: {knowledge_version}\n\n"
            + json.dumps(
                {"summary": summary, "payload": payload},
                ensure_ascii=False,
                indent=2,
            )
        )
    return text


def parse_json_field(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def build_freeze_bundle(
    *,
    knowledge_payload: dict | None,
    knowledge_summary: str | None,
    uploaded_files: list[dict],
    chat_transcript: list[dict],
    existing_test_cases: list[dict] | None = None,
) -> dict:
    return {
        "schema": "freeze-bundle-v1",
        "knowledge": knowledge_payload or {},
        "knowledgeSummary": knowledge_summary,
        "uploadedFiles": uploaded_files,
        "chatTranscript": chat_transcript,
        "existingTestCases": existing_test_cases or [],
    }
