"""Tests for context packet → prompt hints."""

from __future__ import annotations

from app.llm.base import UnitRequest, unit_system_prompt, unit_user_prompt
from app.services.context_packet import (
    format_context_packet_for_prompt,
    related_sources_from_packet,
    testing_hints_from_packet as get_testing_hints_from_packet,
)


def _sample_packet() -> dict:
    return {
        "packetVersion": 1,
        "purpose": "generate-unit",
        "meta": {"language": "TypeScript", "framework": "NestJS", "module": "Auth"},
        "testingStack": {
            "testingFramework": "jest",
            "mockFramework": "jest.mock",
            "assertionLibrary": "expect",
            "detectedFrom": ["language-adapter"],
            "confidence": "medium",
        },
        "sourceUnderTest": {
            "pathRel": "src/auth/auth.service.ts",
            "symbol": "AuthService",
            "methods": ["login"],
            "constructorDeps": ["UserRepository", "JwtService"],
        },
        "unitStrategy": {
            "whatToTest": "Cover Approved TC intent: login ok",
            "whatToMock": ["UserRepository", "JwtService"],
            "whatNotToMock": ["AuthService itself"],
            "forbidden": ["invent APIs not in snippets"],
        },
        "files": [
            {
                "pathRel": "src/auth/auth.service.ts",
                "role": "primary",
                "content": "export class AuthService { login() {} }",
            },
            {
                "pathRel": "src/users/user.repo.ts",
                "role": "dependency",
                "why": "constructor injection",
                "content": "export class UserRepository {}",
            },
            {
                "pathRel": "src/auth/auth.service.spec.ts",
                "role": "test-sample",
                "content": "describe('AuthService', () => {});",
            },
        ],
        "diagnostics": {"truncated": [], "omittedPaths": [], "gaps": ["JwtService iface missing"]},
    }


def test_testing_hints_from_packet():
    hints = get_testing_hints_from_packet(_sample_packet())
    assert hints["testing_framework"] == "jest"
    assert hints["mock_framework"] == "jest.mock"
    assert hints["module"] == "Auth"


def test_related_excludes_primary_and_sample():
    related = related_sources_from_packet(_sample_packet())
    paths = [p for p, _ in related]
    assert paths == ["src/users/user.repo.ts"]


def test_format_packet_includes_strategy():
    text = format_context_packet_for_prompt(_sample_packet())
    assert text is not None
    assert "Unit strategy" in text
    assert "jest" in text
    assert "[test-sample]" in text


def test_unit_user_prompt_includes_stack_and_strategy():
    req = UnitRequest(
        test_case_title="Login ok",
        test_case_type="Functional",
        priority="High",
        steps="1. call login",
        expected_result="token",
        precondition="",
        test_data="",
        source_file_name="auth.service.ts",
        source_code="export class AuthService { login() {} }",
        class_name="AuthService",
        method_name="login",
        framework="NestJS",
        language="TypeScript",
        testing_framework="jest",
        mock_framework="jest.mock",
        assertion_library="expect",
        module="Auth",
        source_under_test_summary="Symbol: AuthService\nMethods: login",
        unit_strategy_summary="Mock: UserRepository, JwtService",
        test_samples=[("auth.service.spec.ts", "describe('x', () => {});")],
        context_gaps=["missing iface"],
    )
    user = unit_user_prompt(req)
    assert "## Testing stack" in user
    assert "jest" in user
    assert "## Unit strategy" in user
    assert "## Style sample" in user
    assert "missing iface" in user

    system = unit_system_prompt(
        "NestJS",
        "TypeScript",
        testing_framework="jest",
        mock_framework="jest.mock",
        assertion_library="expect",
    )
    assert "Jest" in system or "jest" in system.lower()
    assert "jest.mock" in system
