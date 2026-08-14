"""E2E generate / inspect / sandbox-heal / artifact-sync routes (Playwright TS MVP)."""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.llm import LLMError
from app.llm.base import E2EFile, E2ERequest, default_playwright_config
from app.models.domain import AiBackendConnection, Project, TestCase
from app.responses import errors, ok
from app.services.ai_service import (
    connection_runner_mode,
    generate_e2e_for_connection,
)
from app.services.generate_source_resolve import (
    packet_is_usable,
    resolve_from_context_packet,
)
from app.services.e2e_auth_bootstrap import (
    discover_project_auth,
    infer_role_from_text,
    merge_discovered_auth,
    parse_roles_list,
)
from app.services.e2e_auth_seed import (
    apply_auth_to_testcase,
    ensure_auth_seed_roles,
    parse_auth_markers,
)
from app.services.e2e_orchestrator import (
    DEFAULT_MAX_RETRIES,
    E2EOrchestrator,
    check_playwright_ready,
    ensure_playwright_config,
    exc_detail,
)
from app.services.phase5_gen_input import (
    format_e2e_planner_hint,
    merge_related_from_context_files,
    parse_context_files,
    parse_index_version,
    parse_planner,
)

router = APIRouter(
    prefix="/api", tags=["generate-e2e"], dependencies=[Depends(get_current_user)]
)

log = logging.getLogger("aitest.generate.e2e")
_PROJECT_RULES_CAP = 2000


def _cap_project_rules(text: str) -> str:
    s = (text or "").strip()
    if len(s) <= _PROJECT_RULES_CAP:
        return s
    return s[:_PROJECT_RULES_CAP] + "\n…[truncated]"


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


def _e2e_files_dto(files: list[E2EFile]) -> list[dict]:
    return [{"path": f.path, "content": f.content, "kind": f.kind} for f in files]


def _build_e2e_req(tc: TestCase, body: dict, *, project: Project) -> E2ERequest:
    from app.llm.ai_rules import (
        build_user_rules_text,
        parse_project_meta,
    )

    pkg = body.get("packagePrefix", body.get("package_prefix"))
    package_prefix = None if pkg is None else str(pkg)
    related: list[tuple[str, str]] = []
    for item in body.get("relatedSources") or []:
        if isinstance(item, dict) and item.get("path") and item.get("content") is not None:
            related.append((str(item["path"]), str(item["content"])))
    existing: list[tuple[str, str]] = []
    for item in body.get("files") or body.get("existingFiles") or []:
        if isinstance(item, dict) and item.get("path") and item.get("content") is not None:
            existing.append((str(item["path"]), str(item["content"])))
    # Phase 5 — optional contextFiles only fill related when relatedSources empty
    context_files = parse_context_files(body.get("contextFiles") or body.get("context_files"))
    primary_name = str(body.get("sourceFileName") or "").strip()
    related = merge_related_from_context_files(
        related, context_files, primary_path=primary_name
    )
    planner = parse_planner(body.get("planner"))
    index_version = parse_index_version(body.get("indexVersion") or body.get("index_version"))
    # Prefer explicit featurePath; else planner.hints.featurePath (additive)
    feature_path = str(
        body.get("featurePath")
        or body.get("feature_path")
        or body.get("E2E_FEATURE_PATH")
        or ""
    ).strip()
    if not feature_path and planner:
        hints = planner.get("hints") if isinstance(planner.get("hints"), dict) else {}
        feature_path = str((hints or {}).get("featurePath") or "").strip()
    lang = str(body.get("language") or project.language or "TypeScript")
    project_meta = parse_project_meta(getattr(project, "meta", None))
    usr_rules = build_user_rules_text(project_meta)
    # Sprint 2.x strict flow: project rules must come from Desktop profile payload.
    # Missing key is treated as explicit empty to avoid legacy meta fallback.
    raw_project_rules = (
        body.get("projectRules")
        if "projectRules" in body
        else body.get("project_rules")
    )
    proj_rules = _cap_project_rules(str(raw_project_rules or ""))
    src = str(
        body.get("projectRulesSource") or body.get("project_rules_source") or "none"
    ).strip()
    log.info(
        "e2e project_rules source=%s authoritative=true chars=%s",
        src or "none",
        len(proj_rules),
    )
    # Desktop may send enriched testData (path/authRole) — prefer over DB when non-empty
    td_override = str(body.get("testData") or body.get("test_data") or "").strip()
    test_data = td_override if td_override else (tc.test_data or "")
    exec_ctx = str(
        body.get("executionContext") or body.get("execution_context") or ""
    ).strip()
    # Explicit authRole body field → fold into executionContext when missing
    auth_role_body = str(
        body.get("authRole") or body.get("auth_role") or ""
    ).strip()
    if auth_role_body and not re.search(
        r"(?i)\b(?:authRole|auth_role|actor|role)\s*=", exec_ctx
    ):
        prefix = f"actor={auth_role_body}; authRole={auth_role_body}"
        exec_ctx = f"{prefix}; {exec_ctx}".strip("; ").strip()
    return E2ERequest(
        test_case_title=tc.title,
        test_case_type=tc.type or "E2E",
        priority=tc.priority or "Medium",
        steps=tc.steps or "",
        expected_result=tc.expected_result or "",
        precondition=tc.precondition or "",
        test_data=test_data,
        target_url=str(body.get("targetUrl") or body.get("target_url") or "").strip(),
        dom_snapshot=str(body.get("domSnapshot") or body.get("dom_snapshot") or "").strip(),
        source_file_name=primary_name,
        source_code=str(body.get("sourceCode") or "").strip(),
        module=str(body.get("module") or tc.module or "").strip(),
        requirement_title=str(body.get("requirementTitle") or body.get("requirement_title") or "").strip(),
        package_prefix=package_prefix,
        framework=str(body.get("framework") or "playwright"),
        language=lang,
        storage_state_rel=str(
            body.get("storageStateRel") or body.get("storage_state_rel") or ""
        ).strip(),
        seed_command=str(body.get("seedCommand") or body.get("seed_command") or "").strip(),
        teardown_command=str(
            body.get("teardownCommand") or body.get("teardown_command") or ""
        ).strip(),
        repair_context=str(body.get("repairContext") or "").strip(),
        related_sources=related,
        existing_files=existing,
        project_rules=proj_rules,
        user_rules=usr_rules,
        execution_context=exec_ctx,
        feature_path=feature_path,
        locator_contract=str(
            body.get("locatorContract")
            or body.get("locator_contract")
            or ""
        ).strip(),
        pom_scaffold=str(
            body.get("pomScaffold")
            or body.get("pom_scaffold")
            or ""
        ).strip(),
        planner_hint=format_e2e_planner_hint(planner),
        index_version=index_version,
    )


@router.post("/generate-e2e")
async def generate_e2e_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    if project_id is None or test_case_id is None:
        return errors(400, "projectId and testCaseId required")

    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return errors(404, "Project not found")

    tc = (
        db.query(TestCase)
        .filter(TestCase.id == test_case_id, TestCase.project_id == project_id)
        .first()
    )
    if tc is None:
        return errors(404, "test case not found in project")
    if tc.review_status != C.REVIEW_APPROVED:
        return errors(400, "Chỉ Test Case Approved mới Generate E2E (BR-03)")

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return errors(
            400,
            "AI chưa Ready — vào Cấu hình AI thiết lập AI CLI và Verify",
        )

    # Source-context enrichment (same spirit as Unit/API generate):
    # prefer contextPacket, fallback workspace scope, then body legacy.
    has_packet = packet_is_usable(body.get("contextPacket"))
    workspace_id = str(body.get("workspaceId") or "").strip()
    if has_packet and isinstance(body.get("contextPacket"), dict):
        resolved = resolve_from_context_packet(
            body["contextPacket"],
            workspace_id=workspace_id or None,
            body_source_code=str(body.get("sourceCode") or ""),
            body_source_file_name=str(body.get("sourceFileName") or ""),
        )
        body = {
            **body,
            "sourceCode": resolved.source_code,
            "sourceFileName": resolved.source_file_name,
            "relatedSources": [
                {"path": p, "content": c} for p, c in resolved.related_sources
            ],
        }
    elif workspace_id:
        from app.features.workspace.di import get_workspace_service
        from app.features.workspace.generate_scope import resolve_generate_scope

        svc = get_workspace_service()
        session = svc.get(workspace_id)
        if session is None:
            return errors(404, "workspace not found")
        if session.project_id != str(project_id):
            return errors(400, "workspace does not belong to project")
        try:
            scope = await resolve_generate_scope(
                svc,
                workspace_id,
                module=tc.module or "",
                title=tc.title or "",
                body=body,
            )
            primary_content = str(scope.get("primaryContent") or "")
            related = [
                {"path": r["path"], "content": r["content"]}
                for r in (scope.get("related") or [])
                if r.get("path") and r.get("content")
            ]
            if primary_content.strip():
                body = {
                    **body,
                    "sourceCode": primary_content,
                    "sourceFileName": scope.get("primary") or body.get("sourceFileName") or "",
                    "relatedSources": related,
                }
        except Exception as exc:  # noqa: BLE001
            log.warning("e2e workspace resolve skipped: %s", exc)

    # Optional inspect to enrich DOM snapshot.
    # Desktop already inspects (and may clear login-wall DOM) — do NOT refill.
    target_url = str(body.get("targetUrl") or "").strip()
    inspect_warning: str | None = None
    skip_auto_inspect = bool(
        body.get("skipAutoInspect")
        or body.get("skip_auto_inspect")
        or body.get("desktopInspected")
    )
    if (
        not skip_auto_inspect
        and not str(body.get("domSnapshot") or "").strip()
        and (target_url or str(body.get("sourceCode") or "").strip())
    ):
        try:
            from app.services.e2e_dom_inspector import inspect_target

            use_pw = bool(
                body.get("usePlaywrightInspect")
                or body.get("usePlaywright")
                or body.get("storageStateRel")
            )
            project_root = str(body.get("projectRoot") or "").strip()
            feature_path_inspect = str(
                body.get("featurePath")
                or body.get("feature_path")
                or body.get("E2E_FEATURE_PATH")
                or ""
            ).strip()
            storage_rel = str(
                body.get("storageStateRel") or body.get("storage_state_rel") or ""
            ).strip()
            inspected = await inspect_target(
                target_url=target_url,
                source_code=str(body.get("sourceCode") or ""),
                use_playwright=use_pw,
                project_root=project_root,
                feature_path=feature_path_inspect or None,
                storage_state_path=storage_rel or None,
            )
            if inspected.elements or inspected.routes:
                body = {**body, "domSnapshot": inspected.to_prompt_json()}
            else:
                inspect_warning = (
                    "DOM inspect returned no interactive elements — "
                    "check Target URL / auth (storageState or E2E_*) / SPA ready. "
                    f"source={inspected.source or 'empty'}"
                )
                log.warning("e2e inspect empty: %s", inspect_warning)
        except TypeError:
            # Older inspect_target without feature_path kwargs
            try:
                from app.services.e2e_dom_inspector import inspect_target

                inspected = await inspect_target(
                    target_url=target_url,
                    source_code=str(body.get("sourceCode") or ""),
                    use_playwright=bool(
                        body.get("usePlaywrightInspect")
                        or body.get("usePlaywright")
                        or body.get("storageStateRel")
                    ),
                    project_root=str(body.get("projectRoot") or "").strip(),
                )
                if inspected.elements or inspected.routes:
                    body = {**body, "domSnapshot": inspected.to_prompt_json()}
            except Exception as exc:  # noqa: BLE001
                inspect_warning = f"DOM inspect failed: {exc}"
                log.warning("e2e inspect skipped: %s", exc)
        except Exception as exc:  # noqa: BLE001
            inspect_warning = f"DOM inspect failed: {exc}"
            log.warning("e2e inspect skipped: %s", exc)

    req = _build_e2e_req(tc, body, project=project)
    try:
        result, meta = await generate_e2e_for_connection(conn, req)
    except LLMError as exc:
        return errors(400, str(exc))
    except ValueError as exc:
        return errors(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        log.exception("generate-e2e failed")
        return errors(400, f"generate-e2e failed: {exc}")

    files = ensure_playwright_config(
        list(result.files),
        module=req.module,
        package_prefix=req.package_prefix,
        target_url=req.target_url,
        storage_state_rel=req.storage_state_rel,
        requirement_title=req.requirement_title,
        test_case_title=req.test_case_title,
    )
    # Guards already ran in e2e_result_from_raw — re-running appended duplicate POM stubs.
    # Config/auth scaffolding above is enough at route layer.

    auth_seed_dto = None
    project_root = str(body.get("projectRoot") or "").strip()
    skip_auth_seed = bool(body.get("skipAuthSeed") or body.get("skip_auth_seed"))
    if project_root and not skip_auth_seed:
        marker_role, _ref = parse_auth_markers(tc.test_data, tc.precondition)
        roles = parse_roles_list(
            tc.test_data or "",
            tc.precondition or "",
            tc.title or "",
            req.module or "",
        )
        if marker_role and marker_role not in roles:
            roles.insert(0, marker_role)
        if not roles:
            roles = [
                infer_role_from_text(tc.precondition or "", tc.title or "", req.module)
                or "default"
            ]
        seed_results = await ensure_auth_seed_roles(
            project_root=project_root,
            conn=conn,
            roles=roles,
            target_url=req.target_url,
            source_code=req.source_code,
            dom_snapshot=req.dom_snapshot,
            source_file_name=req.source_file_name,
        )
        primary = next((r for r in seed_results if r.ok), seed_results[0] if seed_results else None)
        auth_seed_dto = {
            "primary": primary.to_dict() if primary else None,
            "roles": [r.to_dict() for r in seed_results],
        }
        if primary and primary.ok and primary.auth_rel:
            apply_auth_to_testcase(tc, role=primary.role, auth_rel=primary.auth_rel)
            try:
                db.commit()
                db.refresh(tc)
            except Exception:  # noqa: BLE001
                db.rollback()
                log.warning("attach auth markers to TC failed", exc_info=True)
    elif skip_auth_seed:
        auth_seed_dto = {"skipped": True, "reason": "skipAuthSeed"}

    return ok(
        {
            "files": _e2e_files_dto(files),
            "suggestedPaths": [f.path for f in files],
            "primarySpecPath": result.primary_spec_path,
            "testCaseId": str(tc.id),
            "projectId": str(project.id),
            "provider": meta.get("provider"),
            "runnerUsed": meta.get("runnerUsed") or connection_runner_mode(conn),
            "cliSessionKey": meta.get("cliSessionKey"),
            "authSeed": auth_seed_dto,
            "inspectWarning": inspect_warning,
            "playwrightConfigScaffold": default_playwright_config(
                base_url=req.target_url, storage_state_rel=req.storage_state_rel
            ),
        }
    )



@router.post("/e2e-playwright-check")
async def e2e_playwright_check_route(request: Request):
    """XP0 / gate — detect @playwright/test (project hoặc AITest shared) + npx."""
    body = await request.json()
    project_root = str(body.get("projectRoot") or "").strip()
    if not project_root:
        return errors(400, "projectRoot required")
    pw = check_playwright_ready(project_root)
    return ok(
        {
            "ok": pw.ok,
            "message": pw.message,
            "hasPackage": pw.has_package,
            "hasNpx": pw.has_npx,
            "checkedRoot": pw.checked_root or project_root,
            "packageRoot": pw.package_root,
            "source": pw.source,
            "installHint": (
                "Cài trên AITest (khuyến nghị): POST /e2e-playwright-ensure — "
                "hoặc vào project: npm i -D @playwright/test && npx playwright install chromium"
            ),
        }
    )


@router.post("/e2e-auth-discover")
async def e2e_auth_discover_route(request: Request):
    """Discover auth artifacts / storageState / .env fallback for the SUT project."""
    body = await request.json()
    project_root = str(body.get("projectRoot") or "").strip()
    if not project_root:
        return errors(400, "projectRoot required")
    module = str(body.get("module") or "").strip()
    pkg = body.get("packagePrefix")
    package_prefix = None if pkg is None else str(pkg)
    preferred = str(body.get("role") or body.get("e2eRole") or "").strip() or None
    discovery = discover_project_auth(
        project_root,
        module=module,
        package_prefix=package_prefix,
        preferred_role=preferred,
    )
    return ok(discovery.to_dict())


@router.post("/e2e-auth-ensure")
async def e2e_auth_ensure_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    AI phân tích source/DOM → seed auth (idempotent) → ``.ai-test/auth/{role}.json``.
    Gắn authRole/authRef vào TC nếu có testCaseId. Không cần nhập login trên AITest UI.
    """
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    project_root = str(body.get("projectRoot") or "").strip()
    if project_id is None:
        return errors(400, "projectId required")
    if not project_root:
        return errors(400, "projectRoot required")

    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return errors(404, "Project not found")

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    # AI Ready optional — SUT mine (JHipster i18n/defaults) works without LLM.
    if conn is not None and not C.is_ai_ready(conn.status):
        conn = None

    tc = None
    tc_id = _uuid(str(body.get("testCaseId") or ""))
    if tc_id:
        tc = (
            db.query(TestCase)
            .filter(TestCase.id == tc_id, TestCase.project_id == project_id)
            .first()
        )

    marker_role, _ = parse_auth_markers(
        (tc.test_data if tc else "") or str(body.get("testData") or ""),
        (tc.precondition if tc else "") or "",
    )
    roles = parse_roles_list(
        (tc.test_data if tc else "") or str(body.get("testData") or ""),
        (tc.precondition if tc else "") or "",
        (tc.title if tc else "") or "",
        str(body.get("module") or ""),
    )
    explicit = str(body.get("role") or body.get("e2eRole") or "").strip()
    if explicit:
        roles = [explicit] + [r for r in roles if r != explicit]
    elif marker_role and marker_role not in roles:
        roles.insert(0, marker_role)
    if not roles:
        roles = ["default"]

    # Optional: body.roles = ["admin","investigator"]
    extra_roles = body.get("roles")
    if isinstance(extra_roles, list):
        for r in extra_roles:
            slug = str(r or "").strip().lower()
            if slug and slug not in roles:
                roles.append(slug)

    source_code = str(body.get("sourceCode") or "").strip()
    dom_snapshot = str(body.get("domSnapshot") or "").strip()
    source_file_name = str(body.get("sourceFileName") or "").strip()
    # Fallback: TC fields as analysis hint when UI has no FE source yet
    if not source_code and tc is not None:
        source_code = "\n".join(
            part
            for part in (
                f"## TC title\n{tc.title or ''}",
                f"## Steps\n{tc.steps or ''}",
                f"## Precondition\n{tc.precondition or ''}",
                f"## Test data\n{tc.test_data or ''}",
                f"## Expected\n{tc.expected_result or ''}",
            )
            if part.split("\n", 1)[-1].strip()
        )

    seed_results = await ensure_auth_seed_roles(
        project_root=project_root,
        conn=conn,
        roles=roles,
        target_url=str(body.get("targetUrl") or "").strip(),
        source_code=source_code,
        dom_snapshot=dom_snapshot,
        source_file_name=source_file_name or (tc.title if tc else "") or "",
        force=bool(body.get("force")),
    )
    primary = next((r for r in seed_results if r.ok), seed_results[0] if seed_results else None)
    if tc is not None and primary and primary.ok and primary.auth_rel:
        apply_auth_to_testcase(tc, role=primary.role, auth_rel=primary.auth_rel)
        try:
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()

    return ok(
        {
            **(primary.to_dict() if primary else {"ok": False, "message": "no roles"}),
            "roles": [r.to_dict() for r in seed_results],
        }
    )



@router.post("/e2e-playwright-ensure")
async def e2e_playwright_ensure_route(request: Request):
    """
    Cài @playwright/test + Chromium vào ~/.aitest/playwright-runner (dùng chung).
    Project SUT không cần cài Playwright.
    """
    body = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    force = bool(body.get("force"))
    from app.services.aitest_playwright_runner import ensure_shared_playwright_runner

    try:
        st = await asyncio.to_thread(
            ensure_shared_playwright_runner,
            install_browsers=True,
            force=force,
        )
    except Exception as exc:  # noqa: BLE001
        return errors(400, f"e2e playwright ensure failed: {exc}")
    if not st.ok:
        return errors(400, st.message)
    return ok(
        {
            "ok": True,
            "message": st.message,
            "runnerDir": st.runner_dir,
            "installed": st.installed,
            "source": "aitest",
        }
    )


@router.post("/e2e-inspect")
async def e2e_inspect_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    target_url = str(body.get("targetUrl") or "").strip()
    source_code = str(body.get("sourceCode") or "").strip()
    project_root = str(body.get("projectRoot") or "").strip()
    source_paths = body.get("sourcePaths") or body.get("relatedPaths") or []
    feature_path = str(body.get("featurePath") or body.get("E2E_FEATURE_PATH") or "").strip()
    storage_state_rel = str(
        body.get("storageStatePath")
        or body.get("storageStateRel")
        or body.get("E2E_STORAGE_STATE")
        or ""
    ).strip()
    username = str(body.get("username") or body.get("e2eUsername") or "").strip()
    password = str(body.get("password") or body.get("e2ePassword") or "").strip()
    module = str(body.get("module") or "").strip()
    role = str(body.get("role") or body.get("authRole") or "default").strip() or "default"
    pkg = body.get("packagePrefix", body.get("package_prefix"))
    package_prefix = None if pkg is None else str(pkg)

    pairs: list[tuple[str, str]] = []
    # Phase 1: bare string paths → read from disk, then MERGE with URL (do not early-return).
    if project_root and isinstance(source_paths, list) and source_paths:
        rels = [str(p) for p in source_paths if isinstance(p, str)]
        if rels:
            root = Path(project_root)
            for rel in rels:
                p = root / rel.replace("\\", "/")
                if p.is_file():
                    try:
                        pairs.append(
                            (rel, p.read_text(encoding="utf-8", errors="replace"))
                        )
                    except OSError:
                        pass
        for item in source_paths:
            if isinstance(item, dict) and item.get("path") and item.get("content") is not None:
                pairs.append((str(item["path"]), str(item["content"])))

    if not target_url and not source_code and not pairs:
        return errors(400, "targetUrl, sourceCode, or sourcePaths required")

    use_playwright = bool(
        body.get("usePlaywright")
        or body.get("render") in ("playwright", "chromium", "browser")
    )

    from app.services.e2e_auth_bootstrap import resolve_storage_state_abs

    storage_abs = resolve_storage_state_abs(
        project_root,
        storage_state_rel=storage_state_rel,
        module=module,
        package_prefix=package_prefix,
        role=role,
    )

    from app.services.e2e_dom_inspector import inspect_target

    try:
        result = await inspect_target(
            target_url=target_url,
            source_code=source_code,
            source_paths=pairs,
            use_playwright=use_playwright,
            project_root=project_root,
            storage_state_path=storage_abs,
            feature_path=feature_path,
            username=username,
            password=password,
        )
    except Exception as exc:  # noqa: BLE001
        return errors(400, f"inspect failed: {exc}")

    return ok(
        {
            "targetUrl": result.target_url or None,
            "source": result.source,
            "routes": result.routes,
            "storageStateAbs": storage_abs or None,
            "storageStateUsed": bool(storage_abs),
            "elements": [
                {
                    "tag": e.tag,
                    "role": e.role,
                    "name": e.name,
                    "testId": e.test_id,
                    "ariaLabel": e.aria_label,
                    "placeholder": e.placeholder,
                    "type": e.type,
                    "href": e.href,
                    "selectorCandidates": e.selector_candidates,
                }
                for e in result.elements
            ],
            "promptJson": result.to_prompt_json(),
            "rawSnippet": result.raw_snippet[:2000] if result.raw_snippet else None,
            "featurePath": feature_path or None,
            "postAuth": bool(storage_abs or feature_path or (username and password)),
        }
    )


@router.post("/e2e-sandbox-repair")
async def e2e_sandbox_repair_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    Headless Playwright + Auto-Heal (≤3). projectRoot must be on the same machine as API.
    """
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    project_root = str(body.get("projectRoot") or "").strip()
    if project_id is None or test_case_id is None:
        return errors(400, "projectId and testCaseId required")
    if not project_root:
        return errors(400, "projectRoot required")

    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return errors(404, "Project not found")
    tc = (
        db.query(TestCase)
        .filter(TestCase.id == test_case_id, TestCase.project_id == project_id)
        .first()
    )
    if tc is None:
        return errors(404, "test case not found in project")

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return errors(400, "AI chưa Ready — Verify CLI/API trước")

    # Keep repair prompt aligned with source context when available.
    has_packet = packet_is_usable(body.get("contextPacket"))
    workspace_id = str(body.get("workspaceId") or "").strip()
    if has_packet and isinstance(body.get("contextPacket"), dict):
        resolved = resolve_from_context_packet(
            body["contextPacket"],
            workspace_id=workspace_id or None,
            body_source_code=str(body.get("sourceCode") or ""),
            body_source_file_name=str(body.get("sourceFileName") or ""),
        )
        body = {
            **body,
            "sourceCode": resolved.source_code,
            "sourceFileName": resolved.source_file_name,
            "relatedSources": [
                {"path": p, "content": c} for p, c in resolved.related_sources
            ],
        }

    req = _build_e2e_req(tc, body, project=project)
    files_in = body.get("files") or []
    files: list[E2EFile] = []
    for item in files_in:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        content = str(item.get("content") or "")
        if not path:
            continue
        files.append(
            E2EFile(
                path=path,
                content=content,
                kind=str(item.get("kind") or "spec"),
            )
        )
    if not files:
        return errors(400, "files[] required (page/spec content)")

    primary = str(
        body.get("primarySpecPath") or body.get("specFileRel") or ""
    ).strip()
    if not primary:
        primary = next((f.path for f in files if f.kind == "spec"), files[0].path)

    # XP0.3 — fail fast with install hint (skip when caller injects runCommand for tests)
    if not body.get("runCommand") and not body.get("skipPlaywrightCheck"):
        pw = check_playwright_ready(project_root)
        if not pw.ok:
            return errors(400, f"e2e sandbox repair failed: {pw.message}")

    max_retries = int(body.get("maxRetries") or DEFAULT_MAX_RETRIES)
    max_retries = max(1, min(max_retries, 5))
    run_cmd = body.get("runCommand")
    run_command = None
    if isinstance(run_cmd, list) and run_cmd:
        run_command = [str(x) for x in run_cmd]

    try:
        orch = E2EOrchestrator(
            project_root,
            module=req.module,
            package_prefix=req.package_prefix,
        )
        env_extra, files_auth, discovery = merge_discovered_auth(
            body,
            project_root=project_root,
            module=req.module,
            package_prefix=req.package_prefix,
            files=files,
            tc_precondition=req.precondition,
            tc_title=req.test_case_title,
            tc_test_data=req.test_data,
        )
        if files_auth is not None:
            files = files_auth
        if discovery.notes:
            log.info("e2e auth discover: %s", "; ".join(discovery.notes[:5]))
        sandbox = await orch.execute_sandbox_and_auto_heal(
            files=files,
            primary_spec_path=primary,
            req=req,
            conn=conn,
            max_retries=max_retries,
            run_command=run_command,
            write_file=bool(body.get("writeFile", True)),
            require_playwright=run_command is None,
            headed=bool(body.get("headed") or body.get("showBrowser")),
            env_extra=env_extra,
        )
    except Exception as exc:  # noqa: BLE001
        detail = exc_detail(exc)
        log.exception("e2e-sandbox-repair failed: %s", detail)
        return errors(400, f"e2e sandbox repair failed: {detail}")

    return ok(
        {
            "status": sandbox.status,
            "attempts": sandbox.attempts,
            "primarySpecPath": sandbox.primary_spec_path,
            "files": _e2e_files_dto(sandbox.files),
            "errorLog": sandbox.error_log,
            "workCwd": sandbox.work_cwd,
            "history": [
                {
                    "attempt": h.attempt,
                    "exitCode": h.exit_code,
                    "success": h.success,
                    "logExcerpt": h.log_excerpt,
                }
                for h in sandbox.history
            ],
            "runCommand": sandbox.run_command,
        }
    )


@router.post("/e2e-sandbox-module")
async def e2e_sandbox_module_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    Batch Headless: chạy một lần `playwright test specs/` cho toàn module,
    rồi (tuỳ chọn) heal chọn lọc từng primarySpec fail.
    """
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    project_root = str(body.get("projectRoot") or "").strip()
    if project_id is None:
        return errors(400, "projectId required")
    if not project_root:
        return errors(400, "projectRoot required")

    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return errors(404, "Project not found")

    files_in = body.get("files") or []
    files: list[E2EFile] = []
    for item in files_in:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        content = str(item.get("content") or "")
        if not path:
            continue
        files.append(
            E2EFile(
                path=path,
                content=content,
                kind=str(item.get("kind") or "spec"),
            )
        )
    if not files:
        return errors(400, "files[] required")

    module = str(body.get("module") or "").strip()
    package_prefix = body.get("packagePrefix")
    if package_prefix is not None:
        package_prefix = str(package_prefix)

    if not body.get("runCommand") and not body.get("skipPlaywrightCheck"):
        pw = check_playwright_ready(project_root)
        if not pw.ok:
            return errors(400, f"e2e sandbox module failed: {pw.message}")

    run_cmd = body.get("runCommand")
    run_command = None
    if isinstance(run_cmd, list) and run_cmd:
        run_command = [str(x) for x in run_cmd]

    orch = E2EOrchestrator(
        project_root,
        module=module,
        package_prefix=package_prefix,
    )
    try:
        env_extra, files_auth, discovery = merge_discovered_auth(
            body,
            project_root=project_root,
            module=module,
            package_prefix=package_prefix,
            files=files,
            tc_precondition=str(body.get("precondition") or ""),
            tc_title=str(body.get("title") or ""),
            tc_test_data=str(body.get("testData") or body.get("test_data") or ""),
        )
        if files_auth is not None:
            files = files_auth
        if discovery.notes:
            log.info("e2e auth discover (module): %s", "; ".join(discovery.notes[:5]))
        module_run = await orch.execute_module_headless(
            files=files,
            module=module or None,
            package_prefix=package_prefix,
            target_url=str(body.get("targetUrl") or ""),
            storage_state_rel=str(body.get("storageStateRel") or ""),
            seed_command=str(body.get("seedCommand") or ""),
            teardown_command=str(body.get("teardownCommand") or ""),
            run_command=run_command,
            write_file=bool(body.get("writeFile", True)),
            require_playwright=run_command is None,
            headed=bool(body.get("headed") or body.get("showBrowser")),
            env_extra=env_extra,
        )
    except Exception as exc:  # noqa: BLE001
        detail = exc_detail(exc)
        log.exception("e2e-sandbox-module failed: %s", detail)
        return errors(400, f"e2e sandbox module failed: {detail}")

    heal_results: list[dict] = []
    final_files = list(module_run.files)
    heal_failures = bool(body.get("healFailures", False))
    failed = [s for s in module_run.specs if not s.success]

    if heal_failures and failed:
        conn = (
            db.query(AiBackendConnection)
            .filter(AiBackendConnection.project_id == project_id)
            .first()
        )
        if conn is None or not C.is_ai_ready(conn.status):
            return ok(
                {
                    "status": module_run.status,
                    "files": _e2e_files_dto(final_files),
                    "workCwd": module_run.work_cwd,
                    "log": module_run.log,
                    "runCommand": module_run.run_command,
                    "specs": [
                        {
                            "specPath": s.spec_path,
                            "success": s.success,
                            "title": s.title,
                            "errorExcerpt": s.error_excerpt,
                        }
                        for s in module_run.specs
                    ],
                    "healSkipped": "AI chưa Ready — Verify CLI/API trước",
                    "heal": [],
                }
            )

        # Map primarySpecPath → testCaseId (+ optional per-TC Inspect DOM / FE grounding)
        items = body.get("healItems") or body.get("items") or []
        spec_to_tc: dict[str, str] = {}
        spec_to_dom: dict[str, str] = {}
        spec_to_ground: dict[str, dict] = {}
        if isinstance(items, list):
            for it in items:
                if not isinstance(it, dict):
                    continue
                sp = str(it.get("primarySpecPath") or it.get("specPath") or "").replace(
                    "\\", "/"
                )
                tid = str(it.get("testCaseId") or "").strip()
                dom = str(it.get("domSnapshot") or it.get("dom_snapshot") or "").strip()
                if sp and tid:
                    spec_to_tc[sp] = tid
                    spec_to_tc[sp.split("/")[-1]] = tid
                if sp and dom:
                    spec_to_dom[sp] = dom
                    spec_to_dom[sp.split("/")[-1]] = dom
                if sp:
                    ground = {
                        "featurePath": str(it.get("featurePath") or it.get("feature_path") or "").strip(),
                        "sourceFileName": str(it.get("sourceFileName") or "").strip(),
                        "sourceCode": str(it.get("sourceCode") or ""),
                        "locatorContract": str(
                            it.get("locatorContract") or it.get("locator_contract") or ""
                        ).strip(),
                        "relatedSources": it.get("relatedSources") or it.get("related_sources") or [],
                    }
                    if any(
                        [
                            ground["featurePath"],
                            ground["sourceCode"],
                            ground["locatorContract"],
                        ]
                    ):
                        spec_to_ground[sp] = ground
                        spec_to_ground[sp.split("/")[-1]] = ground

        max_retries = int(body.get("maxRetries") or DEFAULT_MAX_RETRIES)
        max_retries = max(1, min(max_retries, 5))
        work_files = list(final_files)

        for spec in failed:
            sp = spec.spec_path.replace("\\", "/")
            tc_id_str = (
                spec_to_tc.get(sp)
                or spec_to_tc.get(sp.split("/")[-1])
                or str(body.get("testCaseId") or "")
            )
            tc_uuid = _uuid(tc_id_str)
            if tc_uuid is None:
                heal_results.append(
                    {
                        "specPath": sp,
                        "status": "SKIPPED",
                        "errorLog": "No testCaseId mapped for failed spec",
                    }
                )
                continue
            tc = (
                db.query(TestCase)
                .filter(TestCase.id == tc_uuid, TestCase.project_id == project_id)
                .first()
            )
            if tc is None:
                heal_results.append(
                    {
                        "specPath": sp,
                        "status": "SKIPPED",
                        "errorLog": "test case not found",
                    }
                )
                continue
            # Prefer per-TC Inspect + FE grounding from Generate over shared warm-up body
            heal_body = body
            per_dom = spec_to_dom.get(sp) or spec_to_dom.get(sp.split("/")[-1]) or ""
            ground = spec_to_ground.get(sp) or spec_to_ground.get(sp.split("/")[-1]) or {}
            if per_dom or ground:
                heal_body = {**body}
                if per_dom:
                    heal_body["domSnapshot"] = per_dom
                if ground.get("featurePath"):
                    heal_body["featurePath"] = ground["featurePath"]
                if ground.get("sourceFileName"):
                    heal_body["sourceFileName"] = ground["sourceFileName"]
                if ground.get("sourceCode"):
                    heal_body["sourceCode"] = ground["sourceCode"]
                if ground.get("locatorContract"):
                    heal_body["locatorContract"] = ground["locatorContract"]
                if ground.get("relatedSources"):
                    heal_body["relatedSources"] = ground["relatedSources"]
                # Heal must not re-inspect and wipe per-TC grounding
                heal_body["skipAutoInspect"] = True
            req = _build_e2e_req(tc, heal_body, project=project)
            try:
                env_extra, work_auth, _disc = merge_discovered_auth(
                    body,
                    project_root=project_root,
                    module=req.module,
                    package_prefix=req.package_prefix,
                    files=work_files,
                    tc_precondition=req.precondition,
                    tc_title=req.test_case_title,
                    tc_test_data=req.test_data,
                )
                if work_auth is not None:
                    work_files = work_auth
                healed = await orch.execute_sandbox_and_auto_heal(
                    files=work_files,
                    primary_spec_path=sp,
                    req=req,
                    conn=conn,
                    max_retries=max_retries,
                    write_file=bool(body.get("writeFile", True)),
                    require_playwright=run_command is None,
                    headed=bool(body.get("headed") or body.get("showBrowser")),
                    env_extra=env_extra,
                )
            except Exception as exc:  # noqa: BLE001
                heal_results.append(
                    {
                        "specPath": sp,
                        "status": "FAILED",
                        "errorLog": exc_detail(exc),
                    }
                )
                continue
            heal_results.append(
                {
                    "specPath": sp,
                    "status": healed.status,
                    "attempts": healed.attempts,
                    "errorLog": healed.error_log,
                    "primarySpecPath": healed.primary_spec_path,
                }
            )
            if healed.files:
                by_p = {f.path: f for f in work_files}
                for f in healed.files:
                    by_p[f.path] = f
                work_files = list(by_p.values())

        final_files = work_files
        # Recompute overall: module pass if all original specs passed OR healed to PASSED
        healed_ok = {
            str(h.get("specPath") or "").replace("\\", "/"): h.get("status") == "PASSED"
            for h in heal_results
        }
        overall_ok = True
        for s in module_run.specs:
            sp = s.spec_path.replace("\\", "/")
            if s.success:
                continue
            if not healed_ok.get(sp, False):
                overall_ok = False
                break
        status = "PASSED" if overall_ok else "FAILED"
    else:
        status = module_run.status

    return ok(
        {
            "status": status,
            "files": _e2e_files_dto(final_files),
            "workCwd": module_run.work_cwd,
            "log": module_run.log,
            "runCommand": module_run.run_command,
            "specs": [
                {
                    "specPath": s.spec_path,
                    "success": s.success,
                    "title": s.title,
                    "errorExcerpt": s.error_excerpt,
                }
                for s in module_run.specs
            ],
            "heal": heal_results,
        }
    )


@router.post("/e2e-codegen-guard")
async def e2e_codegen_guard_only_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    Phase B helper: run apply_e2e_codegen_guards on Extension-generated files
    without invoking the LLM. Desktop/Extension posts draft files → guarded files.
    """
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    if project_id is None:
        return errors(400, "projectId required")
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return errors(404, "Project not found")

    files_in = body.get("files") or []
    from app.llm.base import E2EFile
    from app.services.e2e_codegen_guard import (
        E2EStrictGateError,
        apply_e2e_codegen_guards,
    )

    files: list[E2EFile] = []
    for item in files_in:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip()
        content = str(item.get("content") or "")
        if not path:
            continue
        files.append(
            E2EFile(
                path=path,
                content=content,
                kind=str(item.get("kind") or "spec"),
            )
        )
    if not files:
        return errors(400, "files[] required")

    try:
        guarded = apply_e2e_codegen_guards(
            files,
            feature_path=str(body.get("featurePath") or ""),
            auth_hints=str(body.get("executionContext") or body.get("authHints") or ""),
            locator_contract=str(body.get("locatorContract") or ""),
            auth_mode=str(body.get("authMode") or body.get("mode") or "") or None,
            use_storage=body.get("useStorageState"),
            test_case_title=str(body.get("title") or ""),
            test_data=str(body.get("testData") or ""),
            strict_gate=bool(body.get("strictGate", True)),
            enforce_journey=bool(body.get("enforceJourney", True)),
            enforce_stubs=bool(body.get("enforceStubs", True)),
        )
    except E2EStrictGateError as exc:
        return errors(400, f"{exc.category}: {exc}")
    except Exception as exc:  # noqa: BLE001
        log.exception("e2e-codegen-guard failed")
        return errors(400, f"e2e-codegen-guard failed: {exc}")

    return ok(
        {
            "status": "OK",
            "files": [
                {"path": f.path, "content": f.content, "kind": getattr(f, "kind", "spec")}
                for f in guarded
            ],
        }
    )


@router.post("/e2e-artifacts-sync")
async def e2e_artifacts_sync_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    project_root = str(body.get("projectRoot") or "").strip()
    if project_id is None:
        return errors(400, "projectId required")
    if not project_root:
        return errors(400, "projectRoot required")

    from app.services.e2e_artifact_sync import sync_e2e_artifacts_from_disk

    try:
        result = sync_e2e_artifacts_from_disk(
            db,
            project_id=project_id,
            project_root=project_root,
            package_prefix=str(body.get("packagePrefix") or ""),
            local_run_id=(body.get("localRunId") or None),
            test_case_id=(body.get("testCaseId") or None),
            module=(body.get("module") or None),
            status=(body.get("status") or None),
            duration_ms=int(body["durationMs"]) if body.get("durationMs") is not None else None,
            primary_spec_path=(body.get("primarySpecPath") or None),
            create_report=bool(body.get("createReport", True)),
        )
    except ValueError as exc:
        return errors(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        return errors(400, f"e2e artifacts sync failed: {exc}")
    return ok(result)
