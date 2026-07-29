"""EX2 — list workspace runs filtered by testType."""

from unittest.mock import MagicMock

from app.routers import audit as audit_router


def test_list_workspace_runs_accepts_test_type_param():
    """Smoke: handler signature includes testType (FastAPI query)."""
    import inspect

    sig = inspect.signature(audit_router.list_workspace_runs)
    assert "testType" in sig.parameters


def test_list_campaigns_accepts_kind_param():
    import inspect

    sig = inspect.signature(audit_router.list_campaigns)
    assert "kind" in sig.parameters
