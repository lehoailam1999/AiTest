"""EX3 — E2E path jail under AItest/E2ETest."""

import pytest

from app.services.test_output_layout import (
    assert_e2e_aitest_target_rel,
    assert_safe_aitest_target_rel,
)


def test_e2e_jail_accepts_e2etest():
    assert (
        assert_e2e_aitest_target_rel("AItest/E2ETest/Login/specs/login.spec.ts")
        == "AItest/E2ETest/Login/specs/login.spec.ts"
    )


def test_e2e_jail_rejects_unittest_folder():
    with pytest.raises(ValueError, match="E2ETest"):
        assert_e2e_aitest_target_rel("AItest/UnitTest/Foo/bar.test.ts")


def test_e2e_jail_rejects_src():
    with pytest.raises(ValueError, match="Path jail"):
        assert_safe_aitest_target_rel("AItest/E2ETest/src/app.ts")


def test_e2e_jail_rejects_outside_aitest():
    with pytest.raises(ValueError, match="AItest"):
        assert_e2e_aitest_target_rel("src/pages/login.spec.ts")
