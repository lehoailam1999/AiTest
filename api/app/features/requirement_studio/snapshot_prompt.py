"""Serialize Freeze Snapshot → prompt for Generate TC.

Hidden synthesis before output: uploaded documents + Knowledge (Phân tích)
+ existing test cases (avoid duplicates, fill gaps).
Chat transcript is optional enrichment only when present in the bundle.
"""

from __future__ import annotations

import json
import re
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
            "Execution context (WHO — auth/role per scenario)",
            _as_list(p.get("executionContexts")),
            fields=(
                "name",
                "actor",
                "authRequired",
                "roles",
                "sessionHint",
                "description",
                "text",
            ),
        )
    )
    lines.extend(
        _line_items(
            "Business rules",
            _as_list(p.get("businessRules")),
            fields=("id", "code", "text", "priority"),
        )
    )
    lines.extend(
        _line_items(
            "Validation & data",
            _as_list(p.get("validationRules")),
            fields=("id", "code", "module", "field", "rule", "text"),
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
        _line_items(
            "Exceptions / errors",
            _as_list(p.get("exceptions")),
            fields=("id", "code", "text"),
        )
    )
    lines.extend(
        _line_items(
            "Acceptance criteria",
            _as_list(p.get("acceptanceCriteria")),
            fields=("id", "code", "text"),
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


def _files_section(
    files: list,
    *,
    max_chars_per_file: int = 8_000,
    max_chars_total: int = 24_000,
) -> list[str]:
    if not files:
        return ["", "## Uploaded documents", "(no extracted text)"]
    out = ["", "## Uploaded documents"]
    used = 0
    for i, f in enumerate(files, 1):
        if not isinstance(f, dict):
            continue
        if used >= max_chars_total:
            out.append(f"…[truncated docs — budget {max_chars_total:,} chars]")
            break
        name = f.get("fileName") or f.get("name") or f"file-{i}"
        text = str(f.get("text") or "").strip()
        out.append(f"### File {i}: {name}")
        if not text:
            out.append("(empty)")
            continue
        room = min(max_chars_per_file, max_chars_total - used)
        if len(text) > room:
            clip = text[: max(0, room - 20)] + "\n...[truncated]"
        else:
            clip = text
        out.append(clip)
        used += len(clip)
    return out


def _item_blob(row: Any) -> str:
    if isinstance(row, dict):
        return " ".join(str(v) for v in row.values() if v is not None).lower()
    return str(row or "").lower()


def _module_match_tokens(module: str) -> list[str]:
    raw = (module or "").strip().lower()
    if not raw:
        return []
    parts = re.split(r"[\s/_\-|:,;.]+", raw)
    tokens = [p for p in parts if len(p) >= 2]
    if raw not in tokens:
        tokens.insert(0, raw)
    return tokens[:12]


def _filter_rows_for_module(rows: list, tokens: list[str], *, keep_min: int = 0) -> list:
    if not rows:
        return []
    if not tokens:
        return rows
    matched = [r for r in rows if any(t in _item_blob(r) for t in tokens)]
    if len(matched) >= max(1, keep_min):
        return matched
    # Too aggressive — keep a small head so prompt still has signal
    return rows[: max(keep_min or 3, 3)]


def _primary_rows_for_module(
    rows: list,
    tokens: set[str],
    *,
    cap: int = 40,
) -> list:
    """
    Module slice for PRIMARY lists: matched rows first, then remaining inventory.
    Avoid dropping BR/VALIDATION/ERROR/AC that omit the Feature name in text.
    """
    all_rows = [r for r in rows if r is not None]
    if not all_rows:
        return []
    matched = _filter_rows_for_module(all_rows, tokens, keep_min=1)
    out: list = []
    seen: set[int] = set()

    def _add(row: Any) -> None:
        i = id(row)
        if i in seen:
            return
        seen.add(i)
        out.append(row)

    for r in matched:
        _add(r)
        if len(out) >= cap:
            return out
    for r in all_rows:
        _add(r)
        if len(out) >= cap:
            break
    return out


def slice_knowledge_payload_for_module(
    knowledge: dict[str, Any] | None,
    module: str,
) -> dict[str, Any]:
    """Keep Feature + related FR/AC/rules/useCases; PRIMARY lists anti-miss union."""
    kw = knowledge if isinstance(knowledge, dict) else {}
    tokens = _module_match_tokens(module)
    features = _as_list(kw.get("features"))
    feat_matched = _filter_rows_for_module(features, tokens, keep_min=1)
    # Prefer exact name match first
    exact = [
        f
        for f in features
        if isinstance(f, dict)
        and str(f.get("name") or f.get("title") or "").strip().lower()
        == (module or "").strip().lower()
    ]
    if exact:
        feat_matched = exact

    return {
        "documentSummary": kw.get("documentSummary") or kw.get("summary") or "",
        "features": feat_matched[:8],
        "actors": _filter_rows_for_module(_as_list(kw.get("actors")), tokens, keep_min=0)[:8],
        "useCases": _filter_rows_for_module(_as_list(kw.get("useCases")), tokens, keep_min=1)[
            :12
        ],
        "executionContexts": _filter_rows_for_module(
            _as_list(kw.get("executionContexts")), tokens, keep_min=0
        )[:10],
        "businessRules": _primary_rows_for_module(
            _as_list(kw.get("businessRules")), tokens, cap=40
        ),
        "validationRules": _primary_rows_for_module(
            _as_list(kw.get("validationRules")), tokens, cap=40
        ),
        "apiSummary": _filter_rows_for_module(
            _as_list(kw.get("apiSummary")), tokens, keep_min=0
        )[:12],
        "exceptions": _primary_rows_for_module(
            _as_list(kw.get("exceptions")), tokens, cap=30
        ),
        "acceptanceCriteria": _primary_rows_for_module(
            _as_list(kw.get("acceptanceCriteria")), tokens, cap=30
        ),
        "constraints": _filter_rows_for_module(
            _as_list(kw.get("constraints")), tokens, keep_min=0
        )[:8],
        "gaps": _as_list(kw.get("gaps"))[:6],
    }


def module_scoped_snapshot_prompt(
    *,
    title: str,
    summary: str | None,
    payload: dict | None,
    knowledge_version: int,
    module: str,
    soft_max: int = 12_000,
) -> str:
    """
    Slim freeze prompt for one fan-out module — Feature slice + related rules,
    truncated docs. Avoids re-sending full Knowledge × N modules.
    """
    p = payload or {}
    if p.get("schema") == "freeze-bundle-v1":
        kw_raw = p.get("knowledge") if isinstance(p.get("knowledge"), dict) else {}
        kw = slice_knowledge_payload_for_module(kw_raw, module)
        kw_summary = coerce_summary_text(p.get("knowledgeSummary") or summary)
        if len(kw_summary) > 1200:
            kw_summary = kw_summary[:1180] + "…"
        slim = {
            "schema": "freeze-bundle-v1",
            "knowledge": kw,
            "knowledgeSummary": kw_summary,
            # Fan-out: Knowledge slice is enough — skip full docs (token/speed)
            "uploadedFiles": [],
            "chatTranscript": [],
            "existingTestCases": [],
        }
        text = snapshot_payload_to_prompt(
            title=f"{title} · module={module}",
            summary=kw_summary,
            payload=slim,
            knowledge_version=knowledge_version,
        )
        # Extra truncate docs already capped in _files_section; enforce soft_max
        if len(text) > soft_max:
            return text[: soft_max - 20] + "\n...[truncated]"
        return text

    # Legacy / plain Knowledge — token filter on full prompt
    return _slice_plain_text_for_module(
        snapshot_payload_to_prompt(
            title=title,
            summary=summary,
            payload=p,
            knowledge_version=knowledge_version,
        ),
        module,
        soft_max=soft_max,
    )


def _slice_plain_text_for_module(text: str, module: str, *, soft_max: int) -> str:
    block = (text or "").strip()
    if not block:
        return ""
    tokens = _module_match_tokens(module)
    if not tokens:
        return block if len(block) <= soft_max else block[: soft_max - 20] + "\n...[truncated]"
    paras = re.split(r"\n{2,}", block)
    head = paras[:2]
    matched = [p for p in paras if any(tok in p.lower() for tok in tokens)]
    merged: list[str] = []
    seen: set[str] = set()
    for p in head + matched:
        key = p[:120]
        if key in seen:
            continue
        seen.add(key)
        merged.append(p)
    out = "\n\n".join(merged).strip()
    if len(out) < max(800, soft_max // 10):
        out = block
    if len(out) <= soft_max:
        return out
    return out[: soft_max - 20] + "\n...[truncated]"


def slice_freeze_content_for_module(
    content: str,
    module: str,
    *,
    soft_max: int = 12_000,
    snap_payload: dict | None = None,
    title: str = "",
    summary: str | None = None,
    knowledge_version: int = 0,
) -> str:
    """Public entry for jobs fan-out — prefer structured slice when payload available."""
    if isinstance(snap_payload, dict) and snap_payload.get("schema") == "freeze-bundle-v1":
        return module_scoped_snapshot_prompt(
            title=title or "Requirement Snapshot",
            summary=summary,
            payload=snap_payload,
            knowledge_version=knowledge_version,
            module=module,
            soft_max=soft_max,
        )
    return _slice_plain_text_for_module(content, module, soft_max=soft_max)


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


def _existing_tcs_section(cases: list, *, titles_only: bool = False) -> list[str]:
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
        if titles_only:
            typ = str(row.get("type") or "").strip()
            out.append(f"{i}. {title}" + (f" · {typ}" if typ else ""))
            continue
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


def knowledge_rich_enough_to_omit_docs(knowledge: dict | None) -> bool:
    """When Knowledge already has module + testable signals, skip re-sending SRS body."""
    kw = knowledge if isinstance(knowledge, dict) else {}
    def _len(key: str) -> int:
        v = kw.get(key)
        return len(v) if isinstance(v, list) else 0

    modules = _len("features") + _len("useCases")
    signals = (
        _len("acceptanceCriteria")
        + _len("validationRules")
        + _len("businessRules")
        + _len("apiSummary")
    )
    return modules >= 1 and signals >= 2


def slim_freeze_payload_for_tc_gen(payload: dict | None) -> dict:
    """
    Single-call TC gen: drop uploaded SRS body when Knowledge is rich
    (same idea as fan-out module slice). Keep title inventory only for existing TCs.
    """
    if not isinstance(payload, dict):
        return {}
    if payload.get("schema") != "freeze-bundle-v1":
        return payload
    out = dict(payload)
    kw = out.get("knowledge") if isinstance(out.get("knowledge"), dict) else {}
    if knowledge_rich_enough_to_omit_docs(kw):
        out["uploadedFiles"] = []
    # Always drop chat for TC gen speed (clarifications already in Knowledge)
    out["chatTranscript"] = []
    existing = _as_list(out.get("existingTestCases"))
    if existing:
        out["existingTestCases"] = [
            {
                "title": str(r.get("title") or "").strip(),
                "type": str(r.get("type") or "").strip(),
            }
            if isinstance(r, dict)
            else r
            for r in existing[:80]
        ]
    return out


def snapshot_payload_to_prompt(
    *,
    title: str,
    summary: str | None,
    payload: dict | None,
    coverage: dict | None = None,  # kept for backward compat; unused in UI
    knowledge_version: int,
    omit_docs_when_rich: bool = False,
    existing_titles_only: bool = False,
) -> str:
    """
    Build LLM input from Freeze bundle (hidden synthesis).
    Always merge: documents + Knowledge + existing TC inventory → accurate output.
    """
    del coverage
    p = payload or {}
    if omit_docs_when_rich and p.get("schema") == "freeze-bundle-v1":
        p = slim_freeze_payload_for_tc_gen(p)
    lines: list[str] = [
        f"# {title or 'Requirement Snapshot'}",
        f"Knowledge version: {knowledge_version}",
        "",
        "You are a senior QA engineer. Synthesize then emit test cases from:",
        "1) Knowledge (Phân tích) = SoT #1 — cover buckets with items; empty → skip,",
        "2) uploaded documents = detail for existing Knowledge signals only,",
        "3) existing TC inventory = avoid duplicates; fill gaps against Knowledge.",
        "Do not invent FR/AC/BR/fields absent from Knowledge. Chat = clarifications only.",
        "Prefer testData `trace: TYPE/id|name` when engine rules require it.",
    ]

    if p.get("schema") == "freeze-bundle-v1":
        kw = p.get("knowledge") if isinstance(p.get("knowledge"), dict) else {}
        kw_summary = p.get("knowledgeSummary") or summary
        kw_text = coerce_summary_text(kw_summary)
        chat = _as_list(p.get("chatTranscript"))
        existing = _as_list(p.get("existingTestCases"))
        if kw_text:
            lines.extend(["", "## Knowledge summary", kw_text])
        files = _as_list(p.get("uploadedFiles"))
        if files:
            lines.extend(_files_section(files))
        elif knowledge_rich_enough_to_omit_docs(kw):
            lines.extend(
                [
                    "",
                    "## Uploaded documents",
                    "(omitted — Knowledge already has features/rules; use Knowledge SoT)",
                ]
            )
        else:
            lines.extend(_files_section([]))
        lines.extend(["", "## Knowledge workspace (Phân tích)"])
        lines.extend(_knowledge_sections(kw))
        lines.extend(
            _existing_tcs_section(existing, titles_only=existing_titles_only)
        )
        lines.extend(_chat_section(chat))
    else:
        # Legacy snapshots (knowledge-only)
        if summary and coerce_summary_text(summary):
            lines.extend(["", "## Summary", coerce_summary_text(summary)])
        lines.extend(["", "## Knowledge workspace"])
        lines.extend(_knowledge_sections(p))
        lines.extend(
            _existing_tcs_section(
                _as_list(p.get("existingTestCases")),
                titles_only=existing_titles_only,
            )
        )

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


def is_freeze_snapshot_prompt(content: str) -> bool:
    """True when content came from snapshot_prompt_content (not legacy ### Feature blocks)."""
    c = (content or "").strip()
    if not c.startswith("# "):
        return False
    markers = (
        "Knowledge version:",
        "## Uploaded documents",
        "## Knowledge workspace",
        "freeze-bundle-v1",
    )
    return any(m in c for m in markers)


def freeze_prompt_has_knowledge(content: str) -> bool:
    """True when freeze text already embeds Knowledge (Phân tích) — skip DB analysis re-inject."""
    c = content or ""
    return (
        "## Knowledge workspace" in c
        or "## Knowledge summary" in c
        or "### Document summary" in c
    )


def freeze_prompt_has_existing_tcs(content: str) -> bool:
    return "## Existing test cases" in (content or "")


def strip_freeze_existing_tcs_section(content: str) -> str:
    """
    Remove freeze inventory block so live DB existing_cases can be the single source.
    Keeps documents + Knowledge intact.
    """
    text = content or ""
    marker = "## Existing test cases"
    idx = text.find(marker)
    if idx < 0:
        return text
    rest = text[idx + len(marker) :]
    cut_at = len(rest)
    offset = 0
    for i, line in enumerate(rest.splitlines(keepends=True)):
        if i > 0 and line.startswith("## ") and not line.startswith("### "):
            cut_at = offset
            break
        offset += len(line)
    return (text[:idx].rstrip() + "\n\n" + rest[cut_at:].lstrip()).strip()


def module_titles_from_snapshot_payload(payload: dict | None) -> list[str]:
    """Derive fan-out module names from structured Knowledge when ### Feature blocks absent."""
    if not isinstance(payload, dict):
        return []
    knowledge = payload.get("knowledge") if isinstance(payload.get("knowledge"), dict) else payload
    if not isinstance(knowledge, dict):
        return []
    titles: list[str] = []
    seen: set[str] = set()

    def _add(name: str) -> None:
        label = (name or "").strip()
        if not label:
            return
        key = label.lower()
        if key in seen:
            return
        seen.add(key)
        titles.append(label)

    for row in _as_list(knowledge.get("features")):
        if isinstance(row, dict):
            _add(str(row.get("name") or row.get("title") or ""))
    if len(titles) < 2:
        for row in _as_list(knowledge.get("useCases")):
            if isinstance(row, dict):
                _add(str(row.get("name") or row.get("title") or ""))
    return titles


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
