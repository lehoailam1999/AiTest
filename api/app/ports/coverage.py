"""Coverage parsers — lcov / cobertura summary meta (W3 / P7)."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET


def parse_lcov(content: str) -> dict:
    lines_found = lines_hit = 0
    for line in content.splitlines():
        if line.startswith("LF:"):
            lines_found += int(line[3:] or 0)
        elif line.startswith("LH:"):
            lines_hit += int(line[3:] or 0)
    pct = round(100.0 * lines_hit / lines_found, 2) if lines_found else 0.0
    return {"linePct": pct, "format": "lcov", "linesFound": lines_found, "linesHit": lines_hit}


def parse_cobertura(content: str) -> dict:
    root = ET.fromstring(content)
    rate = root.attrib.get("line-rate") or root.attrib.get("lineRate")
    branch = root.attrib.get("branch-rate") or root.attrib.get("branchRate")
    line_pct = round(float(rate) * 100, 2) if rate else 0.0
    branch_pct = round(float(branch) * 100, 2) if branch else None
    return {"linePct": line_pct, "branchPct": branch_pct, "format": "cobertura"}


def parse_coverage(fmt: str, content: str) -> dict:
    key = (fmt or "lcov").lower().strip()
    if key in ("cobertura", "xml"):
        return parse_cobertura(content)
    return parse_lcov(content)
