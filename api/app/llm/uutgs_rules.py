"""
UUTGS — Universal Unit Test Generation Specification (System-tier).

Enterprise rule for multi-language / multi-framework Unit *code* generation.
Cursor narrative: ``.cursor/rules/uutgs-unit-codegen.mdc`` — keep in sync.

Injected once via ``unit_system_prompt`` — do NOT restate in user prompt.
"""

from __future__ import annotations

# Compact Specification (SHALL/MUST). Keep under ~2.5k chars for prompt budget.
UUTGS_SPEC = """\
# UUTGS — Universal Unit Test Generation Specification

## 1. Objective
The AI SHALL generate production-ready unit test code that is executable, deterministic,
maintainable, and aligned with the target project's conventions and detected test stack.
This Specification applies to all supported languages and frameworks.

## 2. Principles
### 2.1 Source Code Is the Single Source of Truth
Implementation source (SUT + related sources in the prompt) SHALL be the highest-priority
evidence for behavior. The AI MUST NOT infer behavior solely from names, comments,
SRS, or API docs. Approved Test Case defines scenario *intent*; if intent conflicts with
implementation, implementation SHALL take precedence (brief comment allowed).

### 2.2 Analyze Before Generate
Generation SHALL NOT begin until the AI has performed, from provided context:
syntax · semantic · dependency · control-flow · data-flow · exception · side-effect analysis
(on a language-independent mental model: AST/CFG/DFG/call graph). Language syntax SHALL
be applied only in the final emit phase.

## 3. Context
The AI SHALL use all provided context: SUT, related sources, DI/ctors, DTOs/entities/enums,
utilities, existing tests/helpers/fixtures, Unit strategy, and Gaps. If critical dependencies
are listed under Gaps, the AI MUST NOT invent missing APIs — test the visible surface and
mark TODO only where unavoidable.

## 4. Dependencies
The AI SHALL classify dependencies (pure / internal / external / infrastructure) and mock
ONLY components outside the unit under test (DB, HTTP, queue, cache, FS, cloud, mail, broker).
The AI SHALL NOT mock pure functions, value objects, DTOs, mappers, validators, or utilities
without I/O. Mock behavior SHALL mirror real interaction contracts visible in source.

## 5. Scenario Scope
The Approved Test Case SHALL bound this generation (one coherent scenario file).
Within that scope the AI SHALL derive Arrange/Act/Assert from implementation paths
(input → validation → branch → logic → state → output → exception → side effects).
Cover happy / invalid / boundary / null-empty / exception paths when they are reachable
in the SUT and required to establish the TC expected outcome — no uncovered branch that
the scenario exercises.

## 6. Assertions & Isolation
Each test SHALL assert meaningful behavior (return, state, interactions, events, rollback)
and MUST be independent, deterministic, free of shared mutable order, wall-clock, random,
network, or live DB. No meaningless asserts. No flaky timing.

## 7. Conventions & Stack
The AI SHALL detect language, test framework, mock/assert libraries from the prompt stack
and style samples, then emit idiomatic code for that ecosystem (Jest/Vitest/xUnit/NUnit/
JUnit/pytest/testing/… as detected). Match project naming, AAA (or project equivalent),
fixture/builder/helper patterns from samples.

## 8. Output & Validation
Output ONLY the complete test source file (no markdown fences, no prose).
Imports/namespaces/packages/generics/ctors/DI MUST be valid for the suggested path layout.
Before finish, the AI SHALL self-check: compiles · runnable · isolated · deterministic ·
covers TC intent against implementation · correct mocks · meaningful asserts · no duplicates ·
no production source edits. Fail any criterion → regenerate mentally then emit once.

## 9. Forbidden
Infer from names only · skip exception/edge paths the scenario needs · mock everything ·
invent APIs/behaviors absent from source · nondeterministic tests · duplicate cases ·
import/execute app entrypoints/bootstrap (main/Program/wsgi/Application.main) — test the
extractable unit (pipe/service/handler/validator/DTO) instead · modify production code.
"""


def uutgs_system_block() -> str:
    return UUTGS_SPEC.strip()
