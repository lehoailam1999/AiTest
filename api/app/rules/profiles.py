"""Rule retrieve profiles (Phase 1 scaffolding)."""

from __future__ import annotations

from typing import TypedDict


class RuleProfile(TypedDict):
    id: str
    domains: tuple[str, ...]
    required_tags: tuple[str, ...]
    optional_tags: tuple[str, ...]
    exclude_tags: tuple[str, ...]
    max_chars_budget: int


RULE_PROFILES: dict[str, RuleProfile] = {
    "PROFILE-ANALYSIS-ENRICH": {
        "id": "PROFILE-ANALYSIS-ENRICH",
        "domains": ("analysis",),
        "required_tags": ("fidelity", "features", "flows", "validation", "schema"),
        "optional_tags": ("actors", "br", "api", "ac", "exec-context", "nfr", "gaps"),
        "exclude_tags": ("unit", "playwright"),
        "max_chars_budget": 4500,
    },
    "PROFILE-TC-UNIT": {
        "id": "PROFILE-TC-UNIT",
        "domains": ("tc_gen",),
        "required_tags": ("traceability", "features", "validation", "br", "format"),
        "optional_tags": ("aaa", "bootstrap", "speed"),
        "exclude_tags": ("playwright", "path"),
        "max_chars_budget": 6000,
    },
    "PROFILE-TC-E2E": {
        "id": "PROFILE-TC-E2E",
        "domains": ("tc_gen",),
        "required_tags": ("traceability", "flows", "path", "auth-who", "coverage", "format"),
        "optional_tags": ("auth-hint", "target-url", "speed"),
        "exclude_tags": ("mock",),
        "max_chars_budget": 8000,
    },
    "PROFILE-UNIT-CODEGEN": {
        "id": "PROFILE-UNIT-CODEGEN",
        "domains": ("unit_codegen",),
        "required_tags": ("unit", "mock", "assertion", "isolation", "sut-safety", "portable"),
        "optional_tags": ("naming", "typescript", "csharp"),
        "exclude_tags": ("playwright", "locator", "journey"),
        "max_chars_budget": 9000,
    },
    "PROFILE-E2E-CODEGEN": {
        "id": "PROFILE-E2E-CODEGEN",
        "domains": ("e2e_codegen",),
        "required_tags": ("playwright", "auth", "locator", "journey", "dor", "portable"),
        "optional_tags": ("grounding", "heal", "per-tc-hints"),
        "exclude_tags": ("mock", "sut-safety"),
        "max_chars_budget": 14000,
    },
    "PROFILE-TC-MIXED-DEFAULT": {
        "id": "PROFILE-TC-MIXED-DEFAULT",
        "domains": ("tc_gen",),
        "required_tags": ("tc-gen", "coverage", "format"),
        "optional_tags": (),
        "exclude_tags": ("speed", "traceability"),
        "max_chars_budget": 7000,
    },
    "PROFILE-TC-UNIT-SHARED": {
        "id": "PROFILE-TC-UNIT-SHARED",
        "domains": ("tc_gen",),
        "required_tags": ("tc-gen", "unit", "format"),
        "optional_tags": (),
        "exclude_tags": ("speed", "traceability"),
        "max_chars_budget": 2500,
    },
    "PROFILE-TC-UNIT-SHARED-SPEED": {
        "id": "PROFILE-TC-UNIT-SHARED-SPEED",
        "domains": ("tc_gen",),
        "required_tags": ("tc-gen", "unit", "speed", "format"),
        "optional_tags": (),
        "exclude_tags": ("traceability",),
        "max_chars_budget": 2500,
    },
    "PROFILE-TC-E2E-SHARED": {
        "id": "PROFILE-TC-E2E-SHARED",
        "domains": ("tc_gen",),
        "required_tags": ("tc-gen", "e2e", "format"),
        "optional_tags": (),
        "exclude_tags": ("speed", "traceability"),
        "max_chars_budget": 2500,
    },
    "PROFILE-TC-E2E-SHARED-SPEED": {
        "id": "PROFILE-TC-E2E-SHARED-SPEED",
        "domains": ("tc_gen",),
        "required_tags": ("tc-gen", "e2e", "speed", "format"),
        "optional_tags": (),
        "exclude_tags": ("traceability",),
        "max_chars_budget": 2500,
    },
    "PROFILE-TC-UNIT-ANALYSIS": {
        "id": "PROFILE-TC-UNIT-ANALYSIS",
        "domains": ("tc_gen",),
        "required_tags": ("tc-gen", "unit", "traceability"),
        "optional_tags": (),
        "exclude_tags": ("speed",),
        "max_chars_budget": 3000,
    },
    "PROFILE-TC-UNIT-ANALYSIS-SPEED": {
        "id": "PROFILE-TC-UNIT-ANALYSIS-SPEED",
        "domains": ("tc_gen",),
        "required_tags": ("tc-gen", "unit", "traceability", "speed"),
        "optional_tags": (),
        "exclude_tags": (),
        "max_chars_budget": 1500,
    },
    "PROFILE-TC-E2E-ANALYSIS": {
        "id": "PROFILE-TC-E2E-ANALYSIS",
        "domains": ("tc_gen",),
        "required_tags": ("tc-gen", "e2e", "traceability"),
        "optional_tags": (),
        "exclude_tags": ("speed",),
        "max_chars_budget": 5000,
    },
    "PROFILE-TC-E2E-ANALYSIS-SPEED": {
        "id": "PROFILE-TC-E2E-ANALYSIS-SPEED",
        "domains": ("tc_gen",),
        "required_tags": ("tc-gen", "e2e", "traceability", "speed"),
        "optional_tags": (),
        "exclude_tags": (),
        "max_chars_budget": 2200,
    },
    "PROFILE-ANALYSIS-CHAT": {
        "id": "PROFILE-ANALYSIS-CHAT",
        "domains": ("analysis",),
        "required_tags": ("analysis", "knowledge-diff", "chat"),
        "optional_tags": (),
        "exclude_tags": (),
        "max_chars_budget": 2500,
    },
}

# Profiles currently wired in runtime prompt builders.
ACTIVE_RULE_PROFILE_IDS: tuple[str, ...] = (
    "PROFILE-UNIT-CODEGEN",
    "PROFILE-E2E-CODEGEN",
    "PROFILE-ANALYSIS-ENRICH",
    "PROFILE-ANALYSIS-CHAT",
    "PROFILE-TC-MIXED-DEFAULT",
    "PROFILE-TC-UNIT-SHARED",
    "PROFILE-TC-UNIT-SHARED-SPEED",
    "PROFILE-TC-E2E-SHARED",
    "PROFILE-TC-E2E-SHARED-SPEED",
    "PROFILE-TC-UNIT-ANALYSIS",
    "PROFILE-TC-UNIT-ANALYSIS-SPEED",
    "PROFILE-TC-E2E-ANALYSIS",
    "PROFILE-TC-E2E-ANALYSIS-SPEED",
)

