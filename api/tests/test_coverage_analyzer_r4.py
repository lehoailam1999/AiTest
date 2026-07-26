"""R4 — Requirement Coverage analyzer tests."""

from app.features.requirement_studio.coverage_analyzer import (
    analyze_requirement_coverage,
    coverage_score_pct,
)


def test_coverage_detects_auth_and_missing():
    payload = {
        "summary": "Login flow",
        "businessRules": [{"id": "BR-1", "text": "User must login with password OTP"}],
        "actors": [{"name": "Admin"}],
        "useCases": [],
        "glossary": [],
        "apiSummary": [{"method": "POST", "path": "/api/auth/login"}],
        "databaseSummary": [],
        "constraints": [],
        "openQuestions": [],
        "missingInformation": [],
    }
    cov = analyze_requirement_coverage(payload, chunk_texts=["JWT session token"])
    by_dim = {d["dimension"]: d for d in cov["dimensions"]}
    assert by_dim["Authentication"]["status"] in ("partial", "complete")
    assert "Performance" in cov["missingDimensions"] or by_dim["Performance"]["status"] == "missing"
    assert coverage_score_pct(cov) is not None
    assert len(cov["dimensions"]) == 10


def test_empty_payload_all_missing():
    cov = analyze_requirement_coverage({}, chunk_texts=[])
    assert cov["totals"]["missing"] == 10
    assert coverage_score_pct(cov) == 0.0
