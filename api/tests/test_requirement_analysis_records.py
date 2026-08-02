from app.features.requirement_studio import application as app_svc


def test_analysis_record_types_are_fixed_and_complete():
    assert app_svc.ANALYSIS_RECORD_TYPES == (
        "SUMMARY_SCOPE",
        "FEATURES",
        "ACTORS_PERMISSIONS",
        "BUSINESS_FLOWS",
        "EXECUTION_CONTEXT",
        "BUSINESS_RULES",
        "VALIDATION_DATA",
        "API_UI",
        "ERROR_HANDLING",
        "ACCEPTANCE",
        "NFR_CONSTRAINTS",
        "GAPS",
    )


def test_analysis_records_mapping_from_payload():
    payload = {
        "summary": "Scope summary",
        "features": [{"name": "Login"}],
        "actors": [{"name": "Admin"}],
        "useCases": [{"name": "Đăng nhập", "steps": "1. Mở trang"}],
        "businessRules": [{"id": "BR-1", "text": "Phải đăng nhập"}],
        "validationRules": [{"field": "email", "rule": "required"}],
        "apiSummary": [{"method": "POST", "path": "/api/login"}],
        "exceptions": [{"text": "401 unauthorized"}],
        "acceptanceCriteria": [{"text": "Given valid account"}],
        "constraints": [{"text": "P95 < 2s"}],
        "gaps": [{"text": "Thiếu role matrix"}],
    }
    rows = app_svc._analysis_records_from_payload(payload)  # noqa: SLF001
    by_type = {row["type"]: row for row in rows}

    assert len(rows) == len(app_svc.ANALYSIS_RECORD_TYPES)
    assert set(by_type) == set(app_svc.ANALYSIS_RECORD_TYPES)
    assert by_type["SUMMARY_SCOPE"]["itemCount"] == 1
    assert by_type["FEATURES"]["itemCount"] == 1
    assert by_type["GAPS"]["itemCount"] == 1
