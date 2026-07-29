"""Tests for e2e_artifact_sync."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.domain import Base, ReportRecord
from app.services.e2e_artifact_sync import (
    iter_e2e_artifact_files,
    sync_e2e_artifacts_from_disk,
)


def test_iter_e2e_artifact_files(tmp_path: Path):
    tr = tmp_path / "test-results" / "run1"
    tr.mkdir(parents=True)
    (tr / "video.webm").write_bytes(b"fake")
    (tr / "trace.zip").write_bytes(b"zip")
    (tr / "fail.png").write_bytes(b"png")
    pairs = iter_e2e_artifact_files(str(tmp_path))
    kinds = {k for _, k in pairs}
    assert "video" in kinds
    assert "trace" in kinds
    assert "screenshot" in kinds


def test_sync_e2e_artifacts_from_disk(tmp_path: Path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()

    (tmp_path / "test-results").mkdir()
    (tmp_path / "test-results" / "clip.webm").write_bytes(b"v")

    pid = uuid.uuid4()
    result = sync_e2e_artifacts_from_disk(
        db,
        project_id=pid,
        project_root=str(tmp_path),
        local_run_id="run-1",
        test_case_id=str(uuid.uuid4()),
        module="Auth",
        status="PASSED",
    )
    assert result["artifactCount"] >= 1
    assert result["reportId"]
    row = db.query(ReportRecord).filter(ReportRecord.id == uuid.UUID(result["reportId"])).one()
    assert row.format == "e2e-artifacts"
    meta = json.loads(row.meta_json or "{}")
    assert meta["status"] == "PASSED"
    assert meta["module"] == "Auth"
    db.close()
