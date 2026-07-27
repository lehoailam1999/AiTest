"""Step 4 — coverage / junit parsers + disk sync candidates."""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from app.ports.coverage import (
    detect_format,
    iter_candidate_files,
    parse_cobertura,
    parse_junit,
    parse_lcov,
    parse_report_file,
    parse_trx,
)
from app.services.coverage_sync import sync_coverage_artifacts_from_disk


LCOV_SAMPLE = """TN:
SF:src/auth.py
LF:10
LH:8
end_of_record
"""

COBERTURA_SAMPLE = """<?xml version="1.0" ?>
<coverage line-rate="0.85" branch-rate="0.5" version="1.0">
  <packages/>
</coverage>
"""

JUNIT_SAMPLE = """<?xml version="1.0" ?>
<testsuite name="tests" tests="4" failures="1" errors="0" skipped="1">
  <testcase name="a" classname="T"/>
  <testcase name="b" classname="T"><failure message="x"/></testcase>
  <testcase name="c" classname="T"><skipped/></testcase>
  <testcase name="d" classname="T"/>
</testsuite>
"""

TRX_SAMPLE = """<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult outcome="Passed" testName="A"/>
    <UnitTestResult outcome="Failed" testName="B"/>
    <UnitTestResult outcome="NotExecuted" testName="C"/>
  </Results>
</TestRun>
"""


def test_parse_lcov():
    s = parse_lcov(LCOV_SAMPLE)
    assert s["format"] == "lcov"
    assert s["linesFound"] == 10
    assert s["linesHit"] == 8
    assert s["linePct"] == 80.0


def test_parse_cobertura():
    s = parse_cobertura(COBERTURA_SAMPLE)
    assert s["format"] == "cobertura"
    assert s["linePct"] == 85.0
    assert s["branchPct"] == 50.0


def test_parse_junit():
    s = parse_junit(JUNIT_SAMPLE)
    assert s["format"] == "junit"
    assert s["tests"] == 4
    assert s["failed"] == 1
    assert s["skipped"] == 1
    assert s["passed"] == 2


def test_parse_trx():
    s = parse_trx(TRX_SAMPLE)
    assert s["format"] == "trx"
    assert s["tests"] == 3
    assert s["passed"] == 1
    assert s["failed"] == 1
    assert s["skipped"] == 1


def test_detect_format():
    assert detect_format("coverage/lcov.info", LCOV_SAMPLE) == "lcov"
    assert detect_format("coverage.xml", COBERTURA_SAMPLE) == "cobertura"
    assert detect_format("report.xml", JUNIT_SAMPLE) == "junit"
    assert detect_format("TestResults/a.trx", TRX_SAMPLE) == "trx"


def test_parse_report_file_junit():
    s = parse_report_file("report.xml", JUNIT_SAMPLE)
    assert s["format"] == "junit"
    assert s["fileName"] == "report.xml"
    assert s["tests"] == 4


def test_iter_candidate_files(tmp_path):
    (tmp_path / "coverage.xml").write_text(COBERTURA_SAMPLE, encoding="utf-8")
    (tmp_path / "report.xml").write_text(JUNIT_SAMPLE, encoding="utf-8")
    pkg = tmp_path / "backend"
    pkg.mkdir()
    (pkg / "coverage").mkdir()
    (pkg / "coverage" / "lcov.info").write_text(LCOV_SAMPLE, encoding="utf-8")

    root_hits = iter_candidate_files(str(tmp_path))
    kinds = {rel: kind for rel, kind in root_hits}
    assert kinds.get("coverage.xml") == "coverage"
    assert kinds.get("report.xml") == "junit"

    pkg_hits = iter_candidate_files(str(tmp_path), package_prefix="backend")
    rels = [r for r, _ in pkg_hits]
    assert "backend/coverage/lcov.info" in rels


def test_sync_coverage_artifacts_from_disk(tmp_path):
    (tmp_path / "coverage.xml").write_text(COBERTURA_SAMPLE, encoding="utf-8")
    (tmp_path / "report.xml").write_text(JUNIT_SAMPLE, encoding="utf-8")

    added: list = []
    db = MagicMock()

    def add(row):
        if getattr(row, "id", None) is None:
            row.id = uuid.uuid4()
        added.append(row)

    db.add.side_effect = add

    result = sync_coverage_artifacts_from_disk(
        db,
        project_id=uuid.uuid4(),
        project_root=str(tmp_path),
        local_run_id="run-1",
        test_case_id=str(uuid.uuid4()),
        create_report=True,
    )

    assert result["uploaded"] == 2
    assert result["coverage"]["linePct"] == 85.0
    assert result["junit"]["tests"] == 4
    assert result["reportId"]
    assert db.commit.called
    # 2 CoverageUpload + 1 ReportRecord
    assert len(added) == 3
