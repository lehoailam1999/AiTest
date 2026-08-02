"""
E2E auth bootstrap — discover credentials / roles / storageState from the SUT project
so AITest UI does not require manual login fields.

Sources (priority):
1) AI seed artifacts under ``.ai-test/auth/{role}.json``
2) Valid Playwright storageState under AItest/E2ETest or fixtures/
3) fixtures/auth/roles.json if present
4) Project .env* fallback (E2E_USERNAME, role-scoped keys, …)

Idempotent: if storageState or auth artifact already valid → skip re-seed.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from app.services.e2e_codegen_guard import (
    is_valid_storage_state_json,
    looks_like_storage_state_path,
)
from app.services.test_output_layout import e2e_module_root

logger = logging.getLogger("aitest.e2e.auth")

_ENV_FILE_NAMES = (
    ".env",
    ".env.local",
    ".env.e2e",
    ".env.test",
    ".env.development",
    ".env.development.local",
)

_DEFAULT_USER_KEYS = (
    "E2E_USERNAME",
    "E2E_USER",
    "E2E_EMAIL",
    "TEST_USERNAME",
    "TEST_USER",
    "TEST_EMAIL",
    "PLAYWRIGHT_USERNAME",
    "PLAYWRIGHT_EMAIL",
)
_DEFAULT_PASS_KEYS = (
    "E2E_PASSWORD",
    "E2E_PASS",
    "TEST_PASSWORD",
    "TEST_PASS",
    "PLAYWRIGHT_PASSWORD",
)

_ROLE_USER_RE = re.compile(
    r"^(?:E2E|TEST|PLAYWRIGHT)_(?:ROLE_)?(?P<role>[A-Z][A-Z0-9_]*)_(?:USERNAME|USER|EMAIL)$",
    re.IGNORECASE,
)
_ROLE_PASS_RE = re.compile(
    r"^(?:E2E|TEST|PLAYWRIGHT)_(?:ROLE_)?(?P<role>[A-Z][A-Z0-9_]*)_(?:PASSWORD|PASS)$",
    re.IGNORECASE,
)

@dataclass
class AuthRoleProfile:
    role: str
    username: str | None = None
    password: str | None = None
    storage_state_rel: str | None = None
    storage_state_valid: bool = False
    source: str = "none"
    skipped_seed: bool = False


@dataclass
class AuthDiscovery:
    roles: list[AuthRoleProfile] = field(default_factory=list)
    default_role: str = "default"
    notes: list[str] = field(default_factory=list)
    env_files_read: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "defaultRole": self.default_role,
            "notes": self.notes,
            "envFilesRead": self.env_files_read,
            "roles": [
                {
                    "role": r.role,
                    "hasUsername": bool(r.username),
                    "hasPassword": bool(r.password),
                    "storageStateRel": r.storage_state_rel,
                    "storageStateValid": r.storage_state_valid,
                    "source": r.source,
                    "skippedSeed": r.skipped_seed,
                }
                for r in self.roles
            ],
            "ready": self.is_ready(),
        }

    def is_ready(self) -> bool:
        for r in self.roles:
            if r.storage_state_valid:
                return True
            if r.username and r.password:
                return True
        return False

    def pick(self, role: str | None = None) -> AuthRoleProfile | None:
        want = (role or self.default_role or "default").strip().lower()
        by = {r.role.lower(): r for r in self.roles}
        if want in by:
            return by[want]
        if "default" in by:
            return by["default"]
        return self.roles[0] if self.roles else None


def _parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return out
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("export "):
            s = s[7:].strip()
        if "=" not in s:
            continue
        key, _, val = s.partition("=")
        key = key.strip()
        val = val.strip().strip("'").strip('"')
        if key:
            out[key] = val
    return out


def _load_project_env(project_root: Path) -> tuple[dict[str, str], list[str]]:
    merged: dict[str, str] = {}
    read: list[str] = []
    for name in _ENV_FILE_NAMES:
        p = project_root / name
        if not p.is_file():
            continue
        data = _parse_env_file(p)
        if data:
            merged.update(data)
            read.append(str(p))
    for k, v in os.environ.items():
        if k.startswith(("E2E_", "TEST_", "PLAYWRIGHT_")) and k not in merged and v.strip():
            merged[k] = v.strip()
    return merged, read


def _roles_from_env(env: dict[str, str]) -> dict[str, AuthRoleProfile]:
    roles: dict[str, AuthRoleProfile] = {}

    def ensure(role: str) -> AuthRoleProfile:
        key = role.lower()
        if key not in roles:
            roles[key] = AuthRoleProfile(role=key, source="env")
        return roles[key]

    for k, v in env.items():
        m = _ROLE_USER_RE.match(k)
        if m and v.strip():
            r = ensure(m.group("role"))
            r.username = v.strip()
            r.source = "env"
            continue
        m = _ROLE_PASS_RE.match(k)
        if m and v.strip():
            r = ensure(m.group("role"))
            r.password = v.strip()
            r.source = "env"

    user = next((env[k].strip() for k in _DEFAULT_USER_KEYS if env.get(k, "").strip()), "")
    password = next(
        (env[k].strip() for k in _DEFAULT_PASS_KEYS if env.get(k, "").strip()), ""
    )
    if user or password:
        d = ensure("default")
        if user:
            d.username = user
        if password:
            d.password = password
        d.source = "env"

    return roles


def _load_auth_seed_artifacts(project_root: Path) -> dict[str, AuthRoleProfile]:
    """Load AITest AI-seeded credentials from ``.ai-test/auth/{role}.json``."""
    roles: dict[str, AuthRoleProfile] = {}
    d = project_root / ".ai-test" / "auth"
    if not d.is_dir():
        return roles
    for path in sorted(d.glob("*.json")):
        name = path.name.lower()
        if name in {"roles.json", "package.json"} or name.endswith(".tmp.json"):
            continue
        if name.startswith("seed-"):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        role = str(data.get("role") or path.stem or "").strip().lower() or "default"
        user = str(data.get("username") or data.get("email") or "").strip()
        password = str(data.get("password") or "").strip()
        if not user or not password:
            continue
        roles[role] = AuthRoleProfile(
            role=role,
            username=user,
            password=password,
            source="auth-seed",
            skipped_seed=True,
        )
    return roles


def _load_roles_fixture(project_root: Path) -> dict[str, AuthRoleProfile]:
    roles: dict[str, AuthRoleProfile] = {}
    candidates = [
        project_root / "fixtures" / "auth" / "roles.json",
        project_root / "AItest" / "E2ETest" / "fixtures" / "auth" / "roles.json",
        project_root / ".ai-test" / "auth" / "roles.json",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        items = (
            data
            if isinstance(data, list)
            else data.get("roles")
            if isinstance(data, dict)
            else None
        )
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or item.get("name") or "").strip().lower()
            if not role:
                continue
            roles[role] = AuthRoleProfile(
                role=role,
                username=str(item.get("username") or item.get("email") or "").strip()
                or None,
                password=str(item.get("password") or "").strip() or None,
                source="fixture",
            )
        break
    return roles



def _storage_candidates(
    project_root: Path,
    *,
    module: str = "",
    package_prefix: str | None = None,
    role: str = "default",
) -> list[Path]:
    root = e2e_module_root(module, package_prefix=package_prefix)
    mod_dir = project_root / Path(*root.split("/"))
    role_slug = (
        re.sub(r"[^a-z0-9_-]+", "-", (role or "default").lower()).strip("-") or "default"
    )
    names = [
        f"storageState-{role_slug}.json",
        "storageState.json",
    ]
    if role_slug != "default":
        names.append("storageState-default.json")
    out: list[Path] = []
    for base in (
        mod_dir / "fixtures",
        mod_dir / "fixtures" / "auth",
        project_root / "fixtures" / "auth",
        project_root / "AItest" / "E2ETest" / "fixtures",
        project_root / ".ai-test" / "auth",
    ):
        for name in names:
            out.append(base / name)
    return out


def _rel_to_project(project_root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        return path.as_posix().replace("\\", "/")


def discover_login_path(project_root: str) -> str | None:
    """
    Best-effort login route from SUT E2E/FE sources (project-agnostic).
    Prefers explicit goto('/login') / account/login patterns.
    """
    root = Path(project_root or "")
    if not root.is_dir():
        return None
    patterns = (
        r"""goto\(\s*['"`](/login|/account/login|/signin|/sign-in|/auth/login)['"`]""",
        r"""['"`](/login|/account/login)['"`]\s*,""",
        r"""path\s*:\s*['"`](login|account/login)['"`]""",
    )
    compiled = [re.compile(p, re.I) for p in patterns]
    search_roots = [
        root / "test",
        root / "e2e",
        root / "src",
        root,
    ]
    hits: list[str] = []
    for base in search_roots:
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx", ".vue", ".html"}:
                continue
            low = str(path).replace("\\", "/").lower()
            if any(x in low for x in ("/node_modules/", "/dist/", "/.git/", "/coverage/")):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")[:8000]
            except OSError:
                continue
            for cre in compiled:
                m = cre.search(text)
                if m:
                    raw = m.group(1)
                    if not raw.startswith("/"):
                        raw = "/" + raw
                    hits.append(raw)
                    break
            if len(hits) >= 8:
                break
        if len(hits) >= 8:
            break
    if not hits:
        return None
    # Prefer /login then /account/login
    for preferred in ("/login", "/account/login", "/signin", "/sign-in", "/auth/login"):
        if preferred in hits:
            return preferred
    return hits[0]


def discover_project_auth(
    project_root: str,
    *,
    module: str = "",
    package_prefix: str | None = None,
    preferred_role: str | None = None,
) -> AuthDiscovery:
    root = Path(project_root)
    discovery = AuthDiscovery()
    if not root.is_dir():
        discovery.notes.append(f"projectRoot không tồn tại: {project_root}")
        return discovery

    env, env_files = _load_project_env(root)
    discovery.env_files_read = env_files

    # 1) AI seed artifacts (primary — no AITest UI / no manual .env required)
    roles = _load_auth_seed_artifacts(root)
    # 2) roles.json fixtures
    for k, v in _load_roles_fixture(root).items():
        if k not in roles:
            roles[k] = v
        else:
            if v.username and not roles[k].username:
                roles[k].username = v.username
            if v.password and not roles[k].password:
                roles[k].password = v.password
    # 3) .env fallback only
    for k, v in _roles_from_env(env).items():
        if k not in roles:
            roles[k] = v
        elif not roles[k].username and v.username:
            roles[k].username = v.username
            roles[k].source = f"{roles[k].source}+env"
        elif not roles[k].password and v.password:
            roles[k].password = v.password

    if not roles:
        roles["default"] = AuthRoleProfile(role="default", source="none")

    for role_key, profile in roles.items():
        for cand in _storage_candidates(
            root, module=module, package_prefix=package_prefix, role=role_key
        ):
            if not cand.is_file():
                continue
            try:
                raw = cand.read_text(encoding="utf-8")
            except OSError:
                continue
            if is_valid_storage_state_json(raw):
                profile.storage_state_rel = _rel_to_project(root, cand)
                profile.storage_state_valid = True
                profile.skipped_seed = True
                if profile.source in ("none", "source-hint"):
                    profile.source = "storageState"
                else:
                    profile.source = f"{profile.source}+storageState"
                discovery.notes.append(
                    f"Role `{role_key}`: dùng storageState sẵn có → skip seed/login UI"
                )
                break

    discovery.roles = list(roles.values())
    if preferred_role and preferred_role.strip().lower() in roles:
        discovery.default_role = preferred_role.strip().lower()
    else:
        for r in discovery.roles:
            if r.storage_state_valid:
                discovery.default_role = r.role
                break
        else:
            for r in discovery.roles:
                if r.username and r.password:
                    discovery.default_role = r.role
                    break
            else:
                discovery.default_role = (
                    discovery.roles[0].role if discovery.roles else "default"
                )

    if discovery.is_ready():
        discovery.notes.append(
            "Sẵn sàng auth (ưu tiên .ai-test/auth từ AI seed; fallback .env/storageState)."
        )
    else:
        discovery.notes.append(
            "Chưa có auth artifact. Chạy «Seed auth (AI)» hoặc Generate E2E "
            "để AI phân tích source → tạo .ai-test/auth/{role}.json."
        )
    return discovery


def infer_role_from_text(*parts: str) -> str | None:
    blob = " ".join(p or "" for p in parts).lower()
    for role in (
        "admin",
        "administrator",
        "manager",
        "staff",
        "user",
        "guest",
        "viewer",
        "editor",
    ):
        if re.search(rf"\b{re.escape(role)}\b", blob):
            if role == "administrator":
                return "admin"
            return role
    m = re.search(r"role\s*[:=]\s*([a-z][\w-]{1,24})", blob)
    if m:
        return m.group(1)
    return None


def auth_env_for_role(discovery: AuthDiscovery, role: str | None = None) -> dict[str, str]:
    profile = discovery.pick(role)
    out: dict[str, str] = {}
    if not profile:
        return out
    if profile.username:
        out["E2E_USERNAME"] = profile.username
    if profile.password:
        out["E2E_PASSWORD"] = profile.password
    if profile.role and profile.role != "default":
        out["E2E_ROLE"] = profile.role
    if profile.storage_state_rel and profile.storage_state_valid:
        out["E2E_STORAGE_STATE"] = profile.storage_state_rel
    return out


def read_storage_state_file(project_root: str, rel: str) -> tuple[str, str] | None:
    if not rel.strip():
        return None
    path = Path(project_root) / rel.replace("\\", "/")
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if not is_valid_storage_state_json(raw):
        return None
    return rel.replace("\\", "/"), raw


def attach_storage_state_to_files(
    files: list,
    *,
    project_root: str,
    module: str = "",
    package_prefix: str | None = None,
    storage_rel: str,
    content: str,
) -> list:
    from app.llm.base import E2EFile

    root = e2e_module_root(module, package_prefix=package_prefix)
    # Per-TC layout: put storageState next to the Spec folder (not only module root),
    # otherwise playwright.config.ts under {TC}/ looks for ./fixtures/storageState.json
    # and hits ENOENT while the JSON landed under {Module}/fixtures/.
    for f in files or []:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        low = p.lower()
        for marker in ("/specs/", "/pages/", "/fixtures/", "/types/"):
            if marker in low:
                root = p.split(marker)[0]
                break
        else:
            if low.endswith("playwright.config.ts"):
                root = p.rsplit("/", 1)[0]
                break
            continue
        break
    dest = f"{root}/fixtures/storageState.json"
    out: list = []
    replaced = False
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        if looks_like_storage_state_path(p):
            out.append(E2EFile(path=dest, content=content, kind="fixture"))
            replaced = True
        else:
            out.append(f)
    if not replaced:
        out.append(E2EFile(path=dest, content=content, kind="fixture"))
    _ = (project_root, storage_rel)
    return out


def merge_discovered_auth(
    body: dict,
    *,
    project_root: str,
    module: str = "",
    package_prefix: str | None = None,
    files: list | None = None,
    tc_precondition: str = "",
    tc_title: str = "",
    tc_test_data: str = "",
) -> tuple[dict[str, str], list | None, AuthDiscovery]:
    """
    Merge body playwright env with project discovery.
    Explicit body credentials override discovery.
    """
    from app.services.e2e_auth_seed import load_auth_artifact, parse_auth_markers
    from app.services.e2e_orchestrator import extract_playwright_env

    marker_role, marker_ref = parse_auth_markers(tc_test_data, tc_precondition)
    preferred = (
        str(body.get("e2eRole") or body.get("role") or "").strip()
        or marker_role
        or infer_role_from_text(
            tc_precondition, tc_title, str(body.get("module") or "")
        )
    )
    discovery = discover_project_auth(
        project_root,
        module=module,
        package_prefix=package_prefix,
        preferred_role=preferred,
    )
    discovered = auth_env_for_role(discovery, preferred)

    # Direct authRef on TC → load that file
    if marker_ref:
        ref_path = Path(project_root) / marker_ref.replace("\\", "/")
        if ref_path.is_file():
            try:
                data = json.loads(ref_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    u = str(data.get("username") or data.get("email") or "").strip()
                    p = str(data.get("password") or "").strip()
                    if u and p:
                        discovered["E2E_USERNAME"] = u
                        discovered["E2E_PASSWORD"] = p
            except Exception:
                pass
    elif preferred:
        art = load_auth_artifact(project_root, preferred)
        if art:
            discovered["E2E_USERNAME"] = str(art.get("username") or "")
            discovered["E2E_PASSWORD"] = str(art.get("password") or "")

    # Explicit body override (e2eUsername / playwrightEnv) wins over discovery.
    body_env = extract_playwright_env(body)
    merged = dict(discovered)
    merged.update(body_env)

    if not (merged.get("E2E_LOGIN_PATH") or "").strip():
        login_path = discover_login_path(project_root)
        if login_path:
            merged["E2E_LOGIN_PATH"] = login_path
            discovery.notes.append(f"Discovered E2E_LOGIN_PATH={login_path}")

    out_files = files
    profile = discovery.pick(preferred)
    state_rel = ""
    if profile and profile.storage_state_valid and profile.storage_state_rel:
        state_rel = profile.storage_state_rel
        merged["E2E_STORAGE_STATE"] = state_rel
    elif merged.get("E2E_STORAGE_STATE"):
        state_rel = merged["E2E_STORAGE_STATE"]

    if state_rel and files is not None:
        got = read_storage_state_file(project_root, state_rel)
        if got:
            _, content = got
            out_files = attach_storage_state_to_files(
                files,
                project_root=project_root,
                module=module,
                package_prefix=package_prefix,
                storage_rel=state_rel,
                content=content,
            )
            # Config will use ./fixtures/storageState.json after attach
            merged.pop("E2E_STORAGE_STATE", None)

    return merged, out_files, discovery
