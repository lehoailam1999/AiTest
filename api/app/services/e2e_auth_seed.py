"""
AI-driven E2E auth seed — analyze SUT source/DOM → seed script → local auth artifact.

Artifacts live under ``{projectRoot}/.ai-test/auth/`` (not committed Spec secrets):
  {role}.json          — username/password/role for Playwright inject
  seed-{role}.mjs      — idempotent register/login helper (skip if {role}.json exists)

Priority for Verify: auth artifact → storageState → .env fallback.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.llm.base import truncate
from app.models.domain import AiBackendConnection, TestCase
from app.services.ai_service import chat_for_connection

logger = logging.getLogger("aitest.e2e.auth_seed")

_AUTH_MARKER_ROLE = re.compile(r"(?im)^\s*authRole\s*[:=]\s*(\S+)\s*$")
_AUTH_MARKER_REF = re.compile(r"(?im)^\s*authRef\s*[:=]\s*(\S+)\s*$")

# Parallel E2E generate can race on the same role artifact — serialize per root+role.
_auth_seed_locks: dict[str, asyncio.Lock] = {}
_auth_seed_locks_guard = asyncio.Lock()


async def _auth_seed_lock(project_root: str, role: str) -> asyncio.Lock:
    key = f"{Path(project_root).resolve()}::{_role_slug(role)}"
    async with _auth_seed_locks_guard:
        lock = _auth_seed_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _auth_seed_locks[key] = lock
        return lock


@dataclass
class AuthSeedResult:
    ok: bool
    skipped: bool
    role: str
    auth_rel: str | None
    username: str | None = None
    message: str = ""
    seed_rel: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "skipped": self.skipped,
            "role": self.role,
            "authRel": self.auth_rel,
            "hasUsername": bool(self.username),
            "message": self.message,
            "seedRel": self.seed_rel,
        }


def auth_dir(project_root: str | Path) -> Path:
    return Path(project_root) / ".ai-test" / "auth"


def auth_artifact_path(project_root: str | Path, role: str = "default") -> Path:
    slug = _role_slug(role)
    return auth_dir(project_root) / f"{slug}.json"


def seed_script_path(project_root: str | Path, role: str = "default") -> Path:
    slug = _role_slug(role)
    return auth_dir(project_root) / f"seed-{slug}.mjs"


def _role_slug(role: str) -> str:
    s = re.sub(r"[^a-z0-9_-]+", "-", (role or "default").strip().lower()).strip("-")
    return s or "default"


def _rel(project_root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        return path.as_posix().replace("\\", "/")


# Invented by old seed fallback — never inject into Forensic/JHipster login.
_INVENTED_AUTH_USER_RE = re.compile(
    r"^(e2e_default|e2e\.default(@aitest\.local)?|"
    r"e2e\.[a-z0-9_-]+\.[a-f0-9]{4,8}@aitest\.local)$",
    re.IGNORECASE,
)


def is_invented_auth_username(username: str | None) -> bool:
    """True for placeholder users AI seed invented without a successful register."""
    u = (username or "").strip()
    if not u:
        return False
    return bool(_INVENTED_AUTH_USER_RE.match(u))


def load_auth_artifact(project_root: str | Path, role: str = "default") -> dict | None:
    path = auth_artifact_path(project_root, role)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    user = str(data.get("username") or data.get("email") or "").strip()
    password = str(data.get("password") or "").strip()
    if not user or not password:
        return None
    if is_invented_auth_username(user):
        # Stale artifact from failed AI invent — delete so Verify cannot 401 forever.
        try:
            path.unlink(missing_ok=True)
            logger.warning(
                "Removed invented auth artifact role=%s user=%s path=%s",
                role,
                user,
                path,
            )
        except OSError:
            pass
        return None
    return data


def save_auth_artifact(
    project_root: str | Path,
    *,
    role: str,
    username: str,
    password: str,
    extra: dict | None = None,
) -> Path:
    root = Path(project_root)
    d = auth_dir(root)
    d.mkdir(parents=True, exist_ok=True)
    path = auth_artifact_path(root, role)
    payload = {
        "role": _role_slug(role),
        "username": username.strip(),
        "password": password.strip(),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "source": "aitest-auth-seed",
    }
    if extra:
        for k, v in extra.items():
            if k not in payload and v is not None:
                payload[k] = v
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    gi = d / ".gitignore"
    if not gi.is_file():
        gi.write_text("*\n!.gitignore\n", encoding="utf-8")
    return path


def parse_auth_markers(test_data: str | None, precondition: str | None = None) -> tuple[str | None, str | None]:
    blob = f"{test_data or ''}\n{precondition or ''}"
    role_m = _AUTH_MARKER_ROLE.search(blob)
    ref_m = _AUTH_MARKER_REF.search(blob)
    role = role_m.group(1).strip() if role_m else None
    ref = ref_m.group(1).strip() if ref_m else None
    return role, ref


def attach_auth_markers_to_test_data(
    existing: str | None,
    *,
    role: str,
    auth_rel: str,
) -> str:
    lines = [ln for ln in (existing or "").splitlines() if ln.strip()]
    kept = [
        ln
        for ln in lines
        if not _AUTH_MARKER_ROLE.match(ln) and not _AUTH_MARKER_REF.match(ln)
    ]
    kept.append(f"authRole: {_role_slug(role)}")
    kept.append(f"authRef: {auth_rel.replace(chr(92), '/')}")
    return "\n".join(kept).strip() + "\n"


def _auth_seed_system_prompt() -> str:
    return (
        "You are a senior E2E engineer. Analyze the app source/DOM and produce an idempotent "
        "Node ESM seed script that creates (or reuses) a test login for Playwright.\n"
        "Rules:\n"
        "- Prefer public register/signup API or UI flow grounded in source/DOM — never invent endpoints.\n"
        "- NEVER invent usernames like e2e_default / e2e.default@aitest.local unless the seed script "
        "successfully REGISTERS that user via a real API/UI found in source. Apps without register "
        "must use strategy=credentials-only ONLY when the operator already provisioned the account "
        "(otherwise return strategy=needs-operator-credentials and empty seedScript).\n"
        "- Prefer strategy=api or strategy=ui-register that can recreate/recover the account idempotently.\n"
        "- Password must be strong enough for typical validators (8+ chars, upper/lower/digit).\n"
        "- Output ONLY one JSON object (no markdown) with keys:\n"
        "  role, username, password, strategy (api|ui-register|credentials-only|needs-operator-credentials),\n"
        "  seedScript (string, full .mjs or empty), notes (string).\n"
        "- seedScript receives env E2E_BASE_URL and must write file process.env.AITEST_AUTH_OUT as "
        'JSON {"role","username","password"} ONLY after login/register succeeded. Use global fetch (Node 18+).\n'
        "- Do not put real production secrets. Test-only accounts only.\n"
    )


def _auth_seed_user_prompt(
    *,
    role: str,
    target_url: str,
    source_code: str,
    dom_snapshot: str,
    source_file_name: str,
) -> str:
    return (
        f"## Target role\n{_role_slug(role)}\n"
        f"## Base URL\n{target_url or '(unknown — use relative /api if needed)'}\n"
        f"## FE/BE source hint (`{source_file_name or 'source'}`)\n"
        f"{truncate(source_code, 10000)}\n"
        f"## DOM / interactive snapshot\n"
        f"{truncate(dom_snapshot, 6000)}\n"
        "Return the JSON object now.\n"
    )


def _parse_seed_json(raw: str) -> dict | None:
    text = (raw or "").strip()
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return None
        data = json.loads(text[start : end + 1])
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _run_node_seed(
    script_path: Path,
    *,
    project_root: Path,
    target_url: str,
    out_path: Path,
    timeout_sec: float = 120,
) -> tuple[int, str]:
    env = os.environ.copy()
    env["E2E_BASE_URL"] = (target_url or "http://localhost:3000").rstrip("/")
    env["AITEST_AUTH_OUT"] = str(out_path)
    env["AITEST_AUTH_ROLE"] = out_path.stem
    try:
        completed = subprocess.run(  # noqa: S603
            ["node", str(script_path)],
            cwd=str(project_root),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_sec,
            check=False,
        )
    except FileNotFoundError:
        return 127, "node not found on PATH"
    except subprocess.TimeoutExpired:
        return 124, f"seed timed out after {int(timeout_sec)}s"
    out = (completed.stdout or b"").decode("utf-8", errors="replace")
    err = (completed.stderr or b"").decode("utf-8", errors="replace")
    return int(completed.returncode or 0), f"{out}\n{err}".strip()


async def ensure_auth_seed(
    *,
    project_root: str,
    conn: AiBackendConnection | None,
    role: str = "default",
    target_url: str = "",
    source_code: str = "",
    dom_snapshot: str = "",
    source_file_name: str = "",
    force: bool = False,
) -> AuthSeedResult:
    lock = await _auth_seed_lock(project_root, role)
    async with lock:
        return await _ensure_auth_seed_unlocked(
            project_root=project_root,
            conn=conn,
            role=role,
            target_url=target_url,
            source_code=source_code,
            dom_snapshot=dom_snapshot,
            source_file_name=source_file_name,
            force=force,
        )


async def _ensure_auth_seed_unlocked(
    *,
    project_root: str,
    conn: AiBackendConnection | None,
    role: str = "default",
    target_url: str = "",
    source_code: str = "",
    dom_snapshot: str = "",
    source_file_name: str = "",
    force: bool = False,
) -> AuthSeedResult:
    t0 = time.perf_counter()
    root = Path(project_root)
    role_s = _role_slug(role)
    auth_path = auth_artifact_path(root, role_s)
    auth_rel = _rel(root, auth_path)

    existing = None if force else load_auth_artifact(root, role_s)
    if existing:
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info(
            "auth-seed skip role=%s elapsed_ms=%s reason=artifact-exists",
            role_s,
            elapsed_ms,
        )
        return AuthSeedResult(
            ok=True,
            skipped=True,
            role=role_s,
            auth_rel=auth_rel,
            username=str(existing.get("username") or ""),
            message=f"Đã có auth artifact → skip seed ({auth_rel})",
        )

    # Fast path: mine SUT (JHipster i18n / defaults / cypress.env) — no AITest UI, no AI.
    try:
        from app.services.e2e_auth_sut_mine import materialize_mined_auth_artifacts

        materialize_mined_auth_artifacts(root, roles=[role_s])
        mined = load_auth_artifact(root, role_s)
        if not mined and role_s not in ("admin", "default"):
            # Unknown role → fall back to admin if present (common for feature TCs)
            mined = load_auth_artifact(root, "admin") or load_auth_artifact(root, "default")
            if mined and not force:
                save_auth_artifact(
                    root,
                    role=role_s,
                    username=str(mined.get("username") or ""),
                    password=str(mined.get("password") or ""),
                    extra={
                        "strategy": "sut-mine-fallback",
                        "sourceRole": mined.get("role") or "admin",
                    },
                )
                mined = load_auth_artifact(root, role_s)
        if mined:
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            logger.info(
                "auth-seed sut-mine role=%s elapsed_ms=%s user=%s",
                role_s,
                elapsed_ms,
                mined.get("username"),
            )
            return AuthSeedResult(
                ok=True,
                skipped=False,
                role=role_s,
                auth_rel=auth_rel,
                username=str(mined.get("username") or ""),
                message=(
                    f"Auto auth từ SUT (không cần nhập trên AITest): {auth_rel} "
                    f"user={mined.get('username')}"
                ),
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("sut-mine in ensure_auth_seed failed: %s", exc)

    if conn is None:
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.warning(
            "auth-seed abort role=%s elapsed_ms=%s reason=no-conn",
            role_s,
            elapsed_ms,
        )
        return AuthSeedResult(
            ok=False,
            skipped=False,
            role=role_s,
            auth_rel=None,
            message=(
                "Không mine được user từ project và chưa có AI Ready. "
                "Với JHipster cần .yo-rc.json / i18n login; hoặc nhập override trên AITest."
            ),
        )

    if not (source_code or "").strip() and not (dom_snapshot or "").strip():
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.warning(
            "auth-seed abort role=%s elapsed_ms=%s reason=missing-source-dom",
            role_s,
            elapsed_ms,
        )
        return AuthSeedResult(
            ok=False,
            skipped=False,
            role=role_s,
            auth_rel=None,
            message="Thiếu source/DOM để AI suy ra luồng đăng ký/đăng nhập.",
        )

    try:
        t_ai = time.perf_counter()
        raw, _meta = await chat_for_connection(
            conn,
            _auth_seed_system_prompt(),
            _auth_seed_user_prompt(
                role=role_s,
                target_url=target_url,
                source_code=source_code,
                dom_snapshot=dom_snapshot,
                source_file_name=source_file_name,
            ),
        )
        ai_ms = int((time.perf_counter() - t_ai) * 1000)
        logger.info("auth-seed ai-plan role=%s elapsed_ms=%s", role_s, ai_ms)
    except Exception as exc:  # noqa: BLE001
        logger.exception("auth seed AI failed")
        detail = f"{type(exc).__name__}: {exc}".strip()
        if detail.endswith(":"):
            detail = type(exc).__name__
        return AuthSeedResult(
            ok=False,
            skipped=False,
            role=role_s,
            auth_rel=None,
            message=f"AI seed auth thất bại: {detail}",
        )

    plan = _parse_seed_json(raw)
    if not plan:
        return AuthSeedResult(
            ok=False,
            skipped=False,
            role=role_s,
            auth_rel=None,
            message="AI không trả JSON seed hợp lệ.",
        )

    username = str(plan.get("username") or plan.get("email") or "").strip()
    password = str(plan.get("password") or "").strip()
    strategy = str(plan.get("strategy") or "").strip().lower()
    seed_script = str(plan.get("seedScript") or plan.get("seed_script") or "").strip()
    notes = str(plan.get("notes") or "").strip()

    # Operator must supply real accounts for apps without self-register (Forensic, etc.).
    if strategy in ("needs-operator-credentials", "operator", "manual"):
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
        logger.info(
            "auth-seed abort role=%s elapsed_ms=%s reason=needs-operator-credentials",
            role_s,
            elapsed_ms,
        )
        return AuthSeedResult(
            ok=False,
            skipped=False,
            role=role_s,
            auth_rel=None,
            message=(
                "App không có (hoặc seed không chứng minh được) đăng ký tự động. "
                "Nhập email/mật khẩu thật trên AITest (Tài khoản E2E) rồi Verify lại. "
                + (notes[:200] if notes else "")
            ),
        )

    auth_dir(root).mkdir(parents=True, exist_ok=True)
    seed_rel = None

    if seed_script and strategy not in ("credentials-only", ""):
        sp = seed_script_path(root, role_s)
        if seed_script.startswith("```"):
            seed_script = re.sub(r"^```\w*\n?", "", seed_script)
            seed_script = re.sub(r"\n?```$", "", seed_script)
        sp.write_text(seed_script, encoding="utf-8")
        seed_rel = _rel(root, sp)
        tmp_out = auth_path.with_suffix(".json.tmp")
        t_exec = time.perf_counter()
        code, log = await asyncio.to_thread(
            _run_node_seed,
            sp,
            project_root=root,
            target_url=target_url,
            out_path=tmp_out,
        )
        exec_ms = int((time.perf_counter() - t_exec) * 1000)
        logger.info(
            "auth-seed exec role=%s exit_code=%s elapsed_ms=%s",
            role_s,
            code,
            exec_ms,
        )
        if code == 0 and tmp_out.is_file():
            try:
                produced = json.loads(tmp_out.read_text(encoding="utf-8"))
                u = str(produced.get("username") or produced.get("email") or username).strip()
                p = str(produced.get("password") or password).strip()
                if not u or not p:
                    raise ValueError("seed output missing username/password")
                save_auth_artifact(
                    root,
                    role=role_s,
                    username=u,
                    password=p,
                    extra={"strategy": strategy, "seedLogTail": log[-500:]},
                )
                tmp_out.unlink(missing_ok=True)
                elapsed_ms = int((time.perf_counter() - t0) * 1000)
                logger.info(
                    "auth-seed success role=%s elapsed_ms=%s strategy=%s",
                    role_s,
                    elapsed_ms,
                    strategy or "unknown",
                )
                return AuthSeedResult(
                    ok=True,
                    skipped=False,
                    role=role_s,
                    auth_rel=auth_rel,
                    username=u,
                    seed_rel=seed_rel,
                    message=f"Đã chạy seed và lưu {auth_rel}",
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("seed output parse failed: %s", exc)
        else:
            logger.warning("seed script exit=%s log=%s", code, log[-800:])
            # Do NOT persist invented credentials after a failed seed (401 / user not found).
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            return AuthSeedResult(
                ok=False,
                skipped=False,
                role=role_s,
                auth_rel=None,
                seed_rel=seed_rel,
                message=(
                    "Seed auth thất bại (register/login không thành công). "
                    "Nhập tài khoản thật trên AITest — không dùng user AI bịa (e2e_default). "
                    f"Log: {(log or '')[-400:]}"
                ),
            )

    # credentials-only without a proven seed run: require operator credentials — never invent.
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    logger.info(
        "auth-seed abort role=%s elapsed_ms=%s reason=no-proven-account strategy=%s",
        role_s,
        elapsed_ms,
        strategy or "none",
    )
    return AuthSeedResult(
        ok=False,
        skipped=False,
        role=role_s,
        auth_rel=None,
        seed_rel=seed_rel,
        message=(
            "Không lưu artifact giả. Nhập email/mật khẩu thật của app (Tài khoản E2E), "
            "rồi bấm Kiểm thử — hệ thống sẽ login và tạo storageState. "
            + (notes[:200] if notes else "")
        ),
    )


async def ensure_auth_seed_roles(
    *,
    project_root: str,
    conn: AiBackendConnection | None,
    roles: list[str],
    target_url: str = "",
    source_code: str = "",
    dom_snapshot: str = "",
    source_file_name: str = "",
    force: bool = False,
) -> list[AuthSeedResult]:
    """Seed every role in the list (multi-actor TC / batch). Dedupes slugs."""
    seen: set[str] = set()
    ordered: list[str] = []
    for r in roles or ["default"]:
        slug = _role_slug(r)
        if slug in seen:
            continue
        seen.add(slug)
        ordered.append(slug)
    if not ordered:
        ordered = ["default"]
    results: list[AuthSeedResult] = []
    for slug in ordered:
        results.append(
            await ensure_auth_seed(
                project_root=project_root,
                conn=conn,
                role=slug,
                target_url=target_url,
                source_code=source_code,
                dom_snapshot=dom_snapshot,
                source_file_name=source_file_name,
                force=force,
            )
        )
    return results


def apply_auth_to_testcase(tc: TestCase, *, role: str, auth_rel: str) -> None:
    tc.test_data = attach_auth_markers_to_test_data(
        tc.test_data, role=role, auth_rel=auth_rel
    )
