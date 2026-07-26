from __future__ import annotations

from app.llm.base import truncate

MAX_FILES = 40
MAX_PER_FILE = 5_000
MAX_TOTAL = 24_000


def _files_from_packet(data: dict) -> list[tuple[str, str, str, str]]:
    """Return (path, content, role, why)."""
    files = data.get("files")
    if not isinstance(files, list):
        return []
    out: list[tuple[str, str, str, str]] = []
    for row in files:
        if not isinstance(row, dict):
            continue
        path = (row.get("pathRel") or row.get("path") or "").strip()
        content = (row.get("content") or "").strip()
        role = (row.get("role") or "overview").strip()
        why = (row.get("why") or "").strip()
        if path and content:
            out.append((path, content, role, why))
    return out


def testing_hints_from_packet(packet: dict | None) -> dict[str, str]:
    """Extract testing stack hints for UnitRequest / prompts."""
    if not packet or not isinstance(packet, dict):
        return {}
    stack = packet.get("testingStack") if isinstance(packet.get("testingStack"), dict) else {}
    conv = packet.get("conventions") if isinstance(packet.get("conventions"), dict) else {}
    meta = packet.get("meta") if isinstance(packet.get("meta"), dict) else {}

    testing_fw = (
        (stack.get("testingFramework") or conv.get("testFramework") or "").strip()
    )
    mock_fw = (stack.get("mockFramework") or conv.get("mockFramework") or "").strip()
    assertion = (
        stack.get("assertionLibrary") or conv.get("assertionLibrary") or ""
    ).strip()
    module = (meta.get("module") or "").strip()
    confidence = (stack.get("confidence") or "").strip()
    detected = stack.get("detectedFrom")
    detected_s = ""
    if isinstance(detected, list) and detected:
        detected_s = ", ".join(str(x) for x in detected[:6])

    out: dict[str, str] = {}
    if testing_fw:
        out["testing_framework"] = testing_fw
    if mock_fw:
        out["mock_framework"] = mock_fw
    if assertion:
        out["assertion_library"] = assertion
    if module:
        out["module"] = module
    if confidence:
        out["confidence"] = confidence
    if detected_s:
        out["detected_from"] = detected_s
    return out


def source_under_test_summary(packet: dict | None) -> str:
    if not packet or not isinstance(packet.get("sourceUnderTest"), dict):
        return ""
    s = packet["sourceUnderTest"]
    parts: list[str] = []
    if s.get("pathRel"):
        parts.append(f"Path: {s['pathRel']}")
    if s.get("symbol"):
        parts.append(f"Symbol: {s['symbol']}")
    methods = s.get("methods")
    if isinstance(methods, list) and methods:
        parts.append("Methods: " + ", ".join(str(m) for m in methods[:16]))
    deps = s.get("constructorDeps")
    if isinstance(deps, list) and deps:
        parts.append("Constructor deps: " + ", ".join(str(d) for d in deps[:12]))
    async_m = s.get("asyncMethods")
    if isinstance(async_m, list) and async_m:
        parts.append("Async: " + ", ".join(str(a) for a in async_m[:12]))
    calls = s.get("externalCalls")
    if isinstance(calls, list) and calls:
        parts.append("External calls: " + ", ".join(str(c) for c in calls[:12]))
    return "\n".join(parts)


def unit_strategy_summary(packet: dict | None) -> str:
    if not packet or not isinstance(packet.get("unitStrategy"), dict):
        return ""
    u = packet["unitStrategy"]
    parts: list[str] = []
    if u.get("whatToTest"):
        parts.append(f"What to test: {u['whatToTest']}")
    mocks = u.get("whatToMock")
    if isinstance(mocks, list) and mocks:
        parts.append("Mock: " + ", ".join(str(m) for m in mocks[:12]))
    not_mock = u.get("whatNotToMock")
    if isinstance(not_mock, list) and not_mock:
        parts.append("Do not mock: " + ", ".join(str(m) for m in not_mock[:8]))
    forbidden = u.get("forbidden")
    if isinstance(forbidden, list) and forbidden:
        parts.append("Forbidden:\n- " + "\n- ".join(str(f) for f in forbidden[:8]))
    return "\n".join(parts)


def gaps_from_packet(packet: dict | None) -> list[str]:
    if not packet or not isinstance(packet.get("diagnostics"), dict):
        return []
    gaps = packet["diagnostics"].get("gaps")
    if not isinstance(gaps, list):
        return []
    return [str(g) for g in gaps if str(g).strip()][:8]


def test_samples_from_packet(packet: dict | None) -> list[tuple[str, str]]:
    if not packet:
        return []
    out: list[tuple[str, str]] = []
    for path, content, role, _why in _files_from_packet(packet):
        if role == "test-sample":
            out.append((path, content))
    return out


def format_context_packet_for_prompt(packet: dict | None) -> str | None:
    if not packet or not isinstance(packet, dict):
        return None
    if packet.get("packetVersion") != 1:
        return None

    files = _files_from_packet(packet)
    if not files:
        return None

    purpose = packet.get("purpose") or "generate-tc"
    meta = packet.get("meta") if isinstance(packet.get("meta"), dict) else {}
    lang = meta.get("language") or ""
    fw = meta.get("framework") or ""
    hints = testing_hints_from_packet(packet)

    parts: list[str] = [
        "## Mã nguồn tham khảo (context packet từ Desktop — không lưu trên server)\n",
        f"Mục đích: {purpose}. Language: {lang or '—'}. App framework: {fw or '—'}.\n",
    ]
    if hints.get("testing_framework"):
        parts.append(
            f"Testing stack: {hints['testing_framework']}"
            + (f" · mock {hints['mock_framework']}" if hints.get("mock_framework") else "")
            + (f" · assert {hints['assertion_library']}" if hints.get("assertion_library") else "")
            + ".\n"
        )
    parts.append(
        "Dùng để căn module/API — không bịa class/endpoint không có trong snippet.\n"
    )

    sut = source_under_test_summary(packet)
    if sut:
        parts.append("### Source under test (hints)\n" + sut)

    strategy = unit_strategy_summary(packet)
    if strategy:
        parts.append("### Unit strategy\n" + strategy)

    gaps = gaps_from_packet(packet)
    if gaps:
        parts.append("### Gaps (do not invent)\n- " + "\n- ".join(gaps))

    total = 0
    for path, content, role, why in files[:MAX_FILES]:
        why_s = f" — {why}" if why else ""
        block = f"### [{role}] {path}{why_s}\n{truncate(content, MAX_PER_FILE)}"
        if total + len(block) > MAX_TOTAL:
            break
        parts.append(block)
        total += len(block)

    diag = packet.get("diagnostics")
    if isinstance(diag, dict) and diag.get("truncated"):
        parts.append(f"\n(Ghi chú: đã cắt bớt file: {diag.get('truncated')})")

    return "\n\n".join(parts) if len(parts) > 1 else None


def related_sources_from_packet(packet: dict | None) -> list[tuple[str, str]]:
    if not packet or packet.get("packetVersion") != 1:
        return []
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for path, content, role, _why in _files_from_packet(packet):
        if role in ("primary", "test-sample") or path in seen:
            continue
        seen.add(path)
        out.append((path, content))
    return out


def primary_from_packet(packet: dict | None) -> tuple[str, str] | None:
    if not packet:
        return None
    for path, content, role, _why in _files_from_packet(packet):
        if role == "primary":
            return path, content
    files = _files_from_packet(packet)
    if files:
        path, content, _, _ = files[0]
        return path, content
    return None
