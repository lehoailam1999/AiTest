"""Step 4 — sync coverage / junit artifacts from disk → PostgreSQL."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models.domain import CoverageUpload, ReportRecord
from app.ports.coverage import iter_candidate_files, parse_report_file

logger = logging.getLogger(__name__)


def sync_coverage_artifacts_from_disk(
    db: Session,
    *,
    project_id: uuid.UUID,
    project_root: str,
    package_prefix: str = "",
    package_name: str | None = None,
    local_run_id: str | None = None,
    test_case_id: str | None = None,
    module: str | None = None,
    create_report: bool = True,
) -> dict[str, Any]:
    """
    Quét file coverage/junit phổ biến dưới project_root, parse, ghi CoverageUpload
    (+ ReportRecord tổng hợp khi có dữ liệu).
    Step 5 — package_name phân loại coverage theo sub-package monorepo.
    """
    root = Path(project_root)
    if not root.is_dir():
        raise ValueError(f"projectRoot không tồn tại: {project_root}")

    candidates = iter_candidate_files(project_root, package_prefix)
    uploads: list[dict[str, Any]] = []
    junit_summary: dict[str, Any] | None = None
    coverage_summary: dict[str, Any] | None = None
    pkg_name = (package_name or "").strip() or None

    for rel, kind in candidates:
        full = root / rel
        if not full.is_file():
            continue
        try:
            content = full.read_text(encoding="utf-8", errors="replace")
            summary = parse_report_file(rel, content)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Skip report %s: %s", rel, exc)
            continue

        meta = {
            **summary,
            "localRunId": local_run_id,
            "testCaseId": test_case_id,
            "module": module,
            "packagePrefix": package_prefix or None,
            "packageName": pkg_name,
            "kind": kind,
            "sourcePath": rel,
        }
        fmt = str(summary.get("format") or "lcov")[:40]
        row = CoverageUpload(
            project_id=project_id,
            execution_id=None,
            format=fmt,
            line_pct=float(summary.get("linePct") or 0),
            branch_pct=float(summary["branchPct"])
            if summary.get("branchPct") is not None
            else None,
            meta_json=json.dumps(meta, ensure_ascii=False),
            file_name=rel[:500],
            uploaded_at=datetime.now(timezone.utc),
        )
        db.add(row)
        db.flush()
        item = {
            "id": str(row.id),
            "format": row.format,
            "linePct": row.line_pct,
            "branchPct": row.branch_pct,
            "fileName": row.file_name,
            "kind": kind,
        }
        uploads.append(item)
        if kind == "junit" or fmt in ("junit", "trx"):
            junit_summary = summary
        else:
            coverage_summary = summary

    report_id = None
    if create_report and uploads:
        title = (
            f"Unit sandbox coverage"
            + (f" · {local_run_id}" if local_run_id else "")
        )[:300]
        report = ReportRecord(
            project_id=project_id,
            title=title,
            format="coverage-sync",
            meta_json=json.dumps(
                {
                    "localRunId": local_run_id,
                    "testCaseId": test_case_id,
                    "module": module,
                    "packageName": pkg_name,
                    "packagePrefix": package_prefix or None,
                    "uploads": uploads,
                    "coverage": coverage_summary,
                    "junit": junit_summary,
                },
                ensure_ascii=False,
            ),
            created_at_report=datetime.now(timezone.utc),
        )
        db.add(report)
        db.flush()
        report_id = str(report.id)

    db.commit()
    return {
        "uploaded": len(uploads),
        "uploads": uploads,
        "coverage": coverage_summary,
        "junit": junit_summary,
        "reportId": report_id,
        "candidatesChecked": len(candidates),
        "packageName": pkg_name,
        "packagePrefix": package_prefix or None,
    }
