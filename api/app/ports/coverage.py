"""Coverage / test-report parsers — lcov, cobertura, junit, trx (Step 4)."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path


def parse_lcov(content: str) -> dict:
    lines_found = lines_hit = 0
    for line in content.splitlines():
        if line.startswith("LF:"):
            lines_found += int(line[3:] or 0)
        elif line.startswith("LH:"):
            lines_hit += int(line[3:] or 0)
    pct = round(100.0 * lines_hit / lines_found, 2) if lines_found else 0.0
    return {
        "linePct": pct,
        "format": "lcov",
        "linesFound": lines_found,
        "linesHit": lines_hit,
    }


def parse_cobertura(content: str) -> dict:
    root = ET.fromstring(content)
    rate = root.attrib.get("line-rate") or root.attrib.get("lineRate")
    branch = root.attrib.get("branch-rate") or root.attrib.get("branchRate")
    line_pct = round(float(rate) * 100, 2) if rate else 0.0
    branch_pct = round(float(branch) * 100, 2) if branch else None
    return {"linePct": line_pct, "branchPct": branch_pct, "format": "cobertura"}


def parse_junit(content: str) -> dict:
    """JUnit XML — pass/fail counts (pytest --junitxml, surefire, …)."""
    root = ET.fromstring(content)
    suites = [root] if root.tag.endswith("testsuite") else []
    if root.tag.endswith("testsuites") or root.tag == "testsuites":
        suites = [c for c in root if c.tag.endswith("testsuite")]
    tests = failures = errors = skipped = 0
    for suite in suites or [root]:
        tests += int(suite.attrib.get("tests") or 0)
        failures += int(suite.attrib.get("failures") or 0)
        errors += int(suite.attrib.get("errors") or 0)
        skipped += int(suite.attrib.get("skipped") or suite.attrib.get("disabled") or 0)
    if tests == 0:
        # Count testcase nodes
        cases = root.findall(".//{*}testcase") or root.findall(".//testcase")
        tests = len(cases)
        for case in cases:
            if case.find("{*}failure") is not None or case.find("failure") is not None:
                failures += 1
            if case.find("{*}error") is not None or case.find("error") is not None:
                errors += 1
            if case.find("{*}skipped") is not None or case.find("skipped") is not None:
                skipped += 1
    passed = max(0, tests - failures - errors - skipped)
    return {
        "format": "junit",
        "tests": tests,
        "passed": passed,
        "failed": failures + errors,
        "errors": errors,
        "skipped": skipped,
        "linePct": round(100.0 * passed / tests, 2) if tests else 0.0,
    }


def parse_trx(content: str) -> dict:
    """Visual Studio / dotnet TRX — Outcome counts."""
    root = ET.fromstring(content)
    # Namespace-agnostic
    results = root.findall(".//{*}UnitTestResult") or root.findall(".//UnitTestResult")
    total = len(results)
    passed = failed = skipped = 0
    for r in results:
        outcome = (r.attrib.get("outcome") or "").lower()
        if outcome == "passed":
            passed += 1
        elif outcome in ("failed", "error"):
            failed += 1
        else:
            skipped += 1
    if total == 0:
        counters = root.find(".//{*}ResultSummary/{*}Counters") or root.find(
            ".//ResultSummary/Counters"
        )
        if counters is not None:
            total = int(counters.attrib.get("total") or 0)
            passed = int(counters.attrib.get("passed") or 0)
            failed = int(counters.attrib.get("failed") or 0)
            skipped = int(counters.attrib.get("notExecuted") or 0)
    return {
        "format": "trx",
        "tests": total,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "linePct": round(100.0 * passed / total, 2) if total else 0.0,
    }


def detect_format(file_name: str = "", content: str = "") -> str:
    name = (file_name or "").lower().replace("\\", "/")
    head = (content or "")[:400].lstrip()
    if name.endswith(".info") or "lcov" in name or head.startswith("TN:") or "SF:" in head[:200]:
        return "lcov"
    if name.endswith(".trx") or "TestRun" in head[:200]:
        return "trx"
    if "cobertura" in name or "line-rate=" in head or "lineRate=" in head:
        return "cobertura"
    if (
        name.endswith(".xml")
        and ("testsuite" in head.lower() or "testsuites" in head.lower() or "testcase" in head.lower())
    ):
        return "junit"
    if name.endswith(".xml"):
        return "cobertura"
    return "lcov"


def parse_coverage(fmt: str, content: str) -> dict:
    key = (fmt or "lcov").lower().strip()
    if key in ("cobertura", "xml", "clover"):
        # clover often similar enough — try cobertura attrs first
        try:
            return parse_cobertura(content)
        except Exception:
            if key == "clover":
                return {"linePct": 0.0, "format": "clover"}
            raise
    if key in ("junit", "junitxml"):
        return parse_junit(content)
    if key == "trx":
        return parse_trx(content)
    return parse_lcov(content)


def parse_report_file(file_name: str, content: str) -> dict:
    fmt = detect_format(file_name, content)
    summary = parse_coverage(fmt, content)
    summary["fileName"] = file_name
    summary["format"] = summary.get("format") or fmt
    return summary


# Relative candidates under project / package root (shallow, no recursive glob).
COVERAGE_CANDIDATES: tuple[str, ...] = (
    "coverage/lcov.info",
    "lcov.info",
    "coverage.xml",
    "coverage/cobertura-coverage.xml",
    "coverage/coverage.xml",
    "cobertura.xml",
    "coverage.cobertura.xml",
    "TestResults/coverage.cobertura.xml",
    "AItest/Coverage/lcov.info",
    "AItest/Coverage/coverage.xml",
)

JUNIT_CANDIDATES: tuple[str, ...] = (
    "report.xml",
    "junit.xml",
    "test-results/junit.xml",
    "test-results/results.xml",
    "TestResults/results.xml",
    "AItest/Coverage/junit.xml",
)


def iter_candidate_files(project_root: str, package_prefix: str = "") -> list[tuple[str, str]]:
    """
    Return list of (relative_path, kind) where kind is coverage|junit.
    package_prefix: e.g. 'backend' for monorepo package root.
    """
    root = Path(project_root)
    prefix = (package_prefix or "").replace("\\", "/").strip("/")
    found: list[tuple[str, str]] = []
    seen: set[str] = set()

    search_roots: list[tuple[str, Path]] = [("", root)]
    if prefix:
        search_roots.insert(0, (f"{prefix}/", root / prefix))

    for path_prefix, base in search_roots:
        if not base.is_dir():
            continue
        for rel in COVERAGE_CANDIDATES:
            full = base / rel
            if not full.is_file():
                continue
            key = f"{path_prefix}{rel}".replace("\\", "/")
            if key in seen:
                continue
            seen.add(key)
            found.append((key, "coverage"))
        for rel in JUNIT_CANDIDATES:
            full = base / rel
            if not full.is_file():
                continue
            key = f"{path_prefix}{rel}".replace("\\", "/")
            if key in seen:
                continue
            seen.add(key)
            found.append((key, "junit"))
        trx_dir = base / "TestResults"
        if trx_dir.is_dir():
            for p in sorted(trx_dir.glob("*.trx"))[:5]:
                try:
                    rel_trx = str(p.relative_to(root)).replace("\\", "/")
                except ValueError:
                    continue
                if rel_trx not in seen:
                    seen.add(rel_trx)
                    found.append((rel_trx, "junit"))

    return found
