"""BUSINESS_FLOWS helpers: Mermaid flowchart ↔ numbered steps (dual-field).

Downstream (Freeze / Sinh TC) keeps using ``steps``. Mermaid is additive for
Analysis UI + LLM output; normalize always ensures ``steps`` is present.
"""

from __future__ import annotations

import re
from typing import Any

_FENCE_RE = re.compile(
    r"```(?:mermaid)?\s*([\s\S]*?)```",
    re.IGNORECASE,
)
_FLOWCHART_RE = re.compile(r"^\s*flowchart\s+(TD|TB|BT|RL|LR)\b", re.IGNORECASE | re.M)
_NODE_RE = re.compile(
    r"(?P<id>[A-Za-z][\w]*)\s*"
    r"(?:"
    r"\(\[\s*(?P<stad>[^\]]+?)\s*\]\)"
    r"|\[\s*(?P<sq>[^\]]+?)\s*\]"
    r"|\[\s*\(\s*(?P<round>[^\)]+?)\s*\)\s*\]"
    r"|\(\s*(?P<paren>[^\)]+?)\s*\)"
    r"|\{{\s*(?P<hex>[^\}]+?)\s*\}}"
    r"|\{\s*(?P<diamond>[^\}]+?)\s*\}"
    r"|>\s*(?P<asym>[^\]]+?)\s*\]"
    r")"
)
_NODE_SHAPE = (
    r"(?:"
    r"\(\[[^\]]*\]\)"
    r"|\[[^\]]*\]"
    r"|\([^\)]*\)"
    r"|\{[^\}]*\}"
    r"|\{\{[^\}]*\}\}"
    r"|>[^\]]*\]"
    r")?"
)
_EDGE_RE = re.compile(
    rf"([A-Za-z][\w]*){_NODE_SHAPE}\s*(?:-->|---|-.->|==>|--)\s*(?:\|[^|]*\|\s*)?"
    rf"([A-Za-z][\w]*)"
)
_NUMBERED_STEP_RE = re.compile(
    r"^\s*(?:\d+[\.\)]\s*|[-*]\s+)(.+?)\s*$",
    re.M,
)

# Section / hollow flows that must never become BUSINESS_FLOWS items.
_HOLLOW_FLOW_NAME = re.compile(
    r"(?i)^(?:"
    r"luồng\s+ngoại\s+lệ(?:\s*\([^)]*\))?|"
    r"exception\s+flows?(?:\s*\([^)]*\))?|"
    r"alternate\s+flows?|alternative\s+flows?|error\s+flows?|"
    r"nhánh\s+lỗi|nhánh\s+ngoại\s+lệ"
    r")\.?\s*$"
)
_META_ANALYSIS_ECHO = re.compile(
    r"(?i)(?:"
    r"thiếu\s+điều\s+kiện\s+kích\s+hoạt|"
    r"được\s+khai\s+báo\s+nhưng\s+trống|"
    r"phản\s+hồi\s+quan\s+sát\s+được\s*\(\s*status|"
    r"cho\s+exceptions?\b|"
    r"exception\s+flow\)\s+được\s+khai\s+báo"
    r")"
)

_SKIP_NODE_LABELS = frozenset(
    {
        "bắt đầu",
        "start",
        "kết thúc",
        "end",
        "finish",
        "kết thúc thành công",
        "done",
    }
)

# Injected once for consistent, professional look (LLM + heuristic).
_STYLE_BLOCK = """\
  classDef startEnd fill:#0f766e,stroke:#0d9488,color:#fff,stroke-width:1px
  classDef action fill:#f8fafc,stroke:#475569,color:#0f172a,stroke-width:1px
  classDef decision fill:#fff7ed,stroke:#ea580c,color:#9a3412,stroke-width:1px
"""


def is_hollow_use_case(
    name: str | None,
    steps: str | None = None,
    mermaid: str | None = None,
) -> bool:
    """True when item is empty Exception-Flow heading or analysis meta — not a real UC."""
    n = (name or "").strip()
    s = (steps or "").strip()
    m = sanitize_flow_mermaid(mermaid) if mermaid else ""
    if _HOLLOW_FLOW_NAME.match(n):
        return True
    blob = f"{n}\n{s}\n{m}"
    if _META_ANALYSIS_ECHO.search(blob):
        return True
    labels = _dedupe_action_labels(_step_labels(s), name=n)
    if not labels and m:
        derived = extract_steps_from_mermaid(m)
        labels = _dedupe_action_labels(_step_labels(derived), name=n)
        if not labels and derived:
            labels = _dedupe_action_labels(
                [ln.strip() for ln in derived.splitlines() if ln.strip()],
                name=n,
            )
    if len(labels) == 0:
        return True
    if len(labels) == 1:
        only = labels[0]
        if _HOLLOW_FLOW_NAME.match(only) or _META_ANALYSIS_ECHO.search(only):
            return True
        if n and only.lower() == n.lower():
            return True
        if len(only) > 160 and _META_ANALYSIS_ECHO.search(only):
            return True
    return False


def has_actionable_flow_steps(steps: str | None, *, name: str = "") -> bool:
    """Need ≥2 concrete, de-duplicated action lines before synthesizing mermaid."""
    return len(_dedupe_action_labels(_step_labels(steps), name=name)) >= 2


def strip_mermaid_fence(raw: str | None) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    m = _FENCE_RE.search(text)
    if m:
        return m.group(1).strip()
    return text


def sanitize_flow_mermaid(raw: str | None, *, max_chars: int = 2200) -> str:
    """Keep flowchart body only; polish labels; empty if not a flowchart."""
    body = strip_mermaid_fence(raw)
    if not body:
        return ""
    if not _FLOWCHART_RE.search(body):
        if "-->" in body or "---" in body:
            body = "flowchart TD\n" + body
        else:
            return ""
    body = polish_flow_mermaid(body)
    if len(body) > max_chars:
        body = body[: max_chars - 1].rstrip() + "…"
    return body


def polish_flow_mermaid(body: str) -> str:
    """
    Tighten diagram source: TD direction, short labels, no %% noise,
    inject classDef once for a professional look.
    """
    text = (body or "").strip()
    if not text:
        return ""
    lines = [
        ln
        for ln in text.splitlines()
        if ln.strip() and not ln.strip().startswith("%%")
    ]
    text = "\n".join(lines)
    text = _FLOWCHART_RE.sub("flowchart TD", text, count=1)

    def _repl_stad(m: re.Match[str]) -> str:
        return "([" + _escape_node_label(m.group(1)) + "])"

    def _repl_sq(m: re.Match[str]) -> str:
        return "[" + _escape_node_label(m.group(1)) + "]"

    def _polish_line(ln: str) -> str:
        if "classDef" in ln or ln.strip().startswith("flowchart"):
            return ln
        s = re.sub(r"\(\[\s*([^\]]+?)\s*\]\)", _repl_stad, ln)
        # Decision diamonds only on node lines (id{label})
        s = re.sub(
            r"\b([A-Za-z][\w]*)\{\s*([^{}]+?)\s*\}",
            lambda m: f"{m.group(1)}{{{_escape_node_label(m.group(2))}}}",
            s,
        )
        s = re.sub(r"\[\s*([^\]]+?)\s*\]", _repl_sq, s)
        return s

    text = "\n".join(_polish_line(ln) for ln in text.splitlines())

    if "classDef startEnd" not in text:
        parts = text.splitlines()
        if parts:
            parts.insert(1, _STYLE_BLOCK.rstrip())
            text = "\n".join(parts)

    text = _ensure_node_classes(text)
    return text.strip()


def _ensure_node_classes(text: str) -> str:
    """Append :::startEnd / :::action / :::decision when missing."""
    out_lines: list[str] = []
    for ln in text.splitlines():
        s = ln.rstrip()
        if ":::startEnd" in s or ":::action" in s or ":::decision" in s:
            out_lines.append(s)
            continue
        if "classDef" in s or s.strip().startswith("flowchart"):
            out_lines.append(s)
            continue
        # Edges — leave as-is
        if "-->" in s or "---" in s or "-.->" in s:
            out_lines.append(s)
            continue
        if re.search(r"\(\[[^\]]+\]\)", s):
            out_lines.append(s + ":::startEnd")
        elif re.search(r"\{[^}]+\}", s) and "classDef" not in s:
            out_lines.append(s + ":::decision")
        elif re.search(r"\[[^\]]+\]", s):
            out_lines.append(s + ":::action")
        else:
            out_lines.append(s)
    return "\n".join(out_lines)


def steps_to_linear_mermaid(steps: str | None, *, name: str = "") -> str:
    """Build a clean happy-path flowchart from numbered / bullet steps."""
    labels = _dedupe_action_labels(_step_labels(steps), name=name)
    if len(labels) < 2:
        return ""
    lines = [
        "flowchart TD",
        _STYLE_BLOCK.rstrip(),
        "  S([Bắt đầu]):::startEnd",
    ]
    prev = "S"
    for i, label in enumerate(labels[:8], 1):
        nid = f"N{i}"
        safe = _escape_node_label(label)
        lines.append(f"  {nid}[{safe}]:::action")
        lines.append(f"  {prev} --> {nid}")
        prev = nid
    lines.append("  E([Kết thúc]):::startEnd")
    lines.append(f"  {prev} --> E")
    return polish_flow_mermaid("\n".join(lines))


def extract_steps_from_mermaid(mermaid: str | None, *, max_chars: int = 800) -> str:
    """Linearize node labels in edge order for TC gen / freeze."""
    body = sanitize_flow_mermaid(mermaid)
    if not body:
        return ""

    labels: dict[str, str] = {}
    for m in _NODE_RE.finditer(body):
        nid = m.group("id")
        label = (
            m.group("stad")
            or m.group("sq")
            or m.group("round")
            or m.group("paren")
            or m.group("hex")
            or m.group("diamond")
            or m.group("asym")
            or ""
        ).strip()
        label = label.strip('"').strip("'").strip()
        if label:
            labels[nid] = label

    edges = _EDGE_RE.findall(body)
    ordered_ids: list[str] = []
    seen: set[str] = set()
    if edges:
        outgoing: dict[str, list[str]] = {}
        indeg: dict[str, int] = {}
        for a, b in edges:
            outgoing.setdefault(a, []).append(b)
            indeg[b] = indeg.get(b, 0) + 1
            indeg.setdefault(a, indeg.get(a, 0))
        starts = [n for n, d in indeg.items() if d == 0] or [edges[0][0]]
        stack = list(starts)
        while stack:
            cur = stack.pop(0)
            if cur in seen:
                continue
            seen.add(cur)
            ordered_ids.append(cur)
            for nxt in outgoing.get(cur, []):
                if nxt not in seen:
                    stack.append(nxt)
    if not ordered_ids:
        ordered_ids = list(labels.keys())

    step_labels: list[str] = []
    for nid in ordered_ids:
        lab = (labels.get(nid) or "").strip()
        if not lab:
            continue
        if lab.lower() in _SKIP_NODE_LABELS:
            continue
        if lab not in step_labels:
            step_labels.append(lab)

    step_labels = _dedupe_action_labels(step_labels, name="")
    if not step_labels:
        return ""
    lines = [f"{i}. {lab}" for i, lab in enumerate(step_labels[:8], 1)]
    return "\n".join(lines)[:max_chars]


def enrich_use_case_flow_fields(uc: dict[str, Any]) -> dict[str, Any]:
    """
    Dual-field consistency without redundant text:
    - mermaid SoT for UI; steps derived/kept lean for TC
    - drop hollow Exception-Flow / analysis-meta placeholders
    """
    if not isinstance(uc, dict):
        return {}
    name = _compact_uc_name(str(uc.get("name") or ""))
    steps = str(uc.get("steps") or "").strip()
    mermaid = sanitize_flow_mermaid(str(uc.get("mermaid") or ""))

    if is_hollow_use_case(name, steps, mermaid):
        return {}

    if mermaid and not steps:
        steps = extract_steps_from_mermaid(mermaid)
    steps = _compact_steps(steps, name=name)
    if is_hollow_use_case(name, steps, mermaid):
        return {}

    if steps and not mermaid:
        mermaid = steps_to_linear_mermaid(steps, name=name)
    elif mermaid:
        mermaid = polish_flow_mermaid(mermaid)

    if mermaid and is_hollow_use_case(name, steps, mermaid):
        return {}

    out: dict[str, Any] = {"name": name, "steps": steps[:800]}
    if mermaid:
        out["mermaid"] = mermaid[:2200]
    elif not steps:
        return {}
    return out


def _compact_uc_name(name: str) -> str:
    s = (name or "").strip()
    s = re.sub(r"\s+", " ", s)
    # Drop trailing long prose after em-dash / colon dump
    if " — " in s and len(s) > 80:
        s = s.split(" — ", 1)[0].strip()
    return s[:120]


def _compact_steps(steps: str, *, name: str) -> str:
    labels = _dedupe_action_labels(_step_labels(steps), name=name)
    if not labels:
        # Keep non-numbered prose only if multi-line actionable; else drop echo
        raw_lines = [ln.strip() for ln in (steps or "").splitlines() if ln.strip()]
        labels = _dedupe_action_labels(raw_lines, name=name)
    if not labels:
        return ""
    return "\n".join(f"{i}. {lab}" for i, lab in enumerate(labels[:8], 1))


def _dedupe_action_labels(labels: list[str], *, name: str = "") -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    name_key = _norm_key(name)
    for lab in labels:
        lab2 = re.sub(r"^\d+[\.\)]\s*", "", (lab or "").strip())
        lab2 = re.sub(r"\s+", " ", lab2).strip()
        if not lab2:
            continue
        if _HOLLOW_FLOW_NAME.match(lab2) or _META_ANALYSIS_ECHO.search(lab2):
            continue
        if lab2.lower() in _SKIP_NODE_LABELS:
            continue
        key = _norm_key(lab2)
        if not key or key in seen:
            continue
        if name_key and key == name_key:
            continue
        # Drop labels that are just the name repeated with filler
        if name_key and key.startswith(name_key) and len(key) < len(name_key) + 8:
            continue
        seen.add(key)
        # Keep full wording in steps (node shortens separately)
        out.append(lab2[:80] + ("…" if len(lab2) > 80 else "") if len(lab2) > 80 else lab2)
    return out


def _norm_key(text: str) -> str:
    s = (text or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    return s


def _step_labels(steps: str | None) -> list[str]:
    text = (steps or "").strip()
    if not text:
        return []
    found = [m.group(1).strip() for m in _NUMBERED_STEP_RE.finditer(text)]
    if found:
        return [x for x in found if x][:20]
    return [ln.strip() for ln in text.splitlines() if ln.strip()][:20]


def _escape_node_label(label: str) -> str:
    s = (label or "").strip()
    s = re.sub(r"\s+", " ", s)
    s = s.replace("[", "(").replace("]", ")").replace('"', "'").replace("{", "(").replace("}", ")")
    # Compact labels for Knowledge panel diagrams
    if len(s) > 36:
        s = s[:33].rstrip(" ,;:.-") + "…"
    return s
