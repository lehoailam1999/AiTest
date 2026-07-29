"""
E2E artifact sync — Phase E5.

Quét video / trace / screenshot / playwright-report dưới project root
→ ghi ReportRecord (metadata + paths, không upload binary).
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models.domain import ReportRecord

logger = logging.getLogger(__name__)

_VIDEO_EXT = {".webm", ".mp4"}
_TRACE_NAMES = {"trace.zip"}
_SCREENSHOT_EXT = {".png", ".jpg", ".jpeg"}
_REPORT_NAMES = {"playwright-report.json", "results.json", "report.json"}


def _kind_for(path: Path) -> str | None:
    name = path.name.lower()
    if name in _TRACE_NAMES or name.endswith(".zip") and "trace" in name:
        return "trace"
    if name in _REPORT_NAMES or path.suffix.lower() == ".html" and "playwright" in str(path).lower():
        return "report"
    if path.suffix.lower() in _VIDEO_EXT:
        return "video"
    if path.suffix.lower() in _SCREENSHOT_EXT:
        return "screenshot"
    return None


def iter_e2e_artifact_files(
    project_root: str,
    *,
    package_prefix: str = "",
    search_roots: list[str] | None = None,
) -> list[tuple[str, str]]:
    """Return list of (relative_path, kind)."""
    root = Path(project_root)
    pkg = (package_prefix or "").replace("\\", "/").strip("/")
    base = root / pkg if pkg else root
    candidates = search_roots or [
        "test-results",
        "playwright-report",
        "AItest/E2ETest",
        "AItest/Reports",
    ]
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    for rel_root in candidates:
        folder = base / rel_root.replace("\\", "/")
        if not folder.exists():
            continue
        for p in folder.rglob("*"):
            if not p.is_file():
                continue
            kind = _kind_for(p)
            if not kind:
                continue
            try:
                rel = str(p.relative_to(root)).replace("\\", "/")
            except ValueError:
                continue
            if rel in seen:
                continue
            seen.add(rel)
            found.append((rel, kind))
    return found


def sync_e2e_artifacts_from_disk(
    db: Session,
    *,
    project_id: uuid.UUID,
    project_root: str,
    package_prefix: str = "",
    local_run_id: str | None = None,
    test_case_id: str | None = None,
    module: str | None = None,
    status: str | None = None,
    duration_ms: int | None = None,
    primary_spec_path: str | None = None,
    create_report: bool = True,
) -> dict[str, Any]:
    root = Path(project_root)
    if not root.is_dir():
        raise ValueError(f"projectRoot không tồn tại: {project_root}")

    pairs = iter_e2e_artifact_files(project_root, package_prefix=package_prefix)
    artifacts: list[dict[str, Any]] = []
    for rel, kind in pairs:
        full = root / rel
        size = full.stat().st_size if full.is_file() else None
        artifacts.append(
            {
                "kind": kind,
                "path": rel,
                "sizeBytes": size,
            }
        )

    report_id = None
    if create_report:
        title = (
            "E2E artifacts"
            + (f" · {local_run_id}" if local_run_id else "")
            + (f" · {module}" if module else "")
        )[:300]
        meta = {
            "localRunId": local_run_id,
            "testCaseId": test_case_id,
            "module": module,
            "packagePrefix": package_prefix or None,
            "status": status,
            "durationMs": duration_ms,
            "primarySpecPath": primary_spec_path,
            "artifacts": artifacts,
            "kind": "e2e",
        }
        report = ReportRecord(
            project_id=project_id,
            title=title,
            format="e2e-artifacts",
            meta_json=json.dumps(meta, ensure_ascii=False),
            created_at_report=datetime.now(timezone.utc),
        )
        db.add(report)
        db.flush()
        report_id = str(report.id)
        db.commit()
    else:
        db.commit()

    return {
        "reportId": report_id,
        "artifactCount": len(artifacts),
        "artifacts": artifacts,
        "packagePrefix": package_prefix or None,
        "status": status,
    }
