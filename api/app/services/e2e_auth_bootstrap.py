"""
E2E auth bootstrap — discover credentials / roles / storageState from the SUT project
so AITest UI does not require manual login fields.

Sources (priority):
1) AI seed / SUT-mine artifacts under ``.ai-test/auth/{role}.json``
2) Valid Playwright storageState under AItest/E2ETest or fixtures/
3) fixtures/auth/roles.json if present
4) Deterministic SUT mine (i18n / cypress.env / JHipster defaults) → auto-write artifacts
5) Project .env* fallback (E2E_USERNAME, role-scoped keys, …)

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
from app.services.test_output_layout import e2e_module_root, e2e_shared_root

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
    from app.services.e2e_auth_seed import is_invented_auth_username, load_auth_artifact

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
        role = path.stem.strip().lower() or "default"
        # Prefer load_auth_artifact (rejects + deletes invented e2e_default).
        data = load_auth_artifact(project_root, role)
        if not data:
            continue
        user = str(data.get("username") or data.get("email") or "").strip()
        password = str(data.get("password") or "").strip()
        if not user or not password or is_invented_auth_username(user):
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


def resolve_storage_state_abs(
    project_root: str,
    *,
    storage_state_rel: str = "",
    module: str = "",
    package_prefix: str | None = None,
    role: str = "default",
) -> str:
    """
    Absolute path to a valid Playwright storageState.json for Inspect post-auth.

    Desktop often sends ``./fixtures/storageState.json`` (TC-cwd relative) which
    does not exist under project root — fall back to AItest/E2ETest/**/fixtures
    and .ai-test/auth discoveries.
    """
    rel = (storage_state_rel or "").strip().replace("\\", "/")
    root = Path(project_root or "").expanduser()

    def _ok(path: Path) -> str:
        if not path.is_file():
            return ""
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            return ""
        if not is_valid_storage_state_json(raw):
            return ""
        return str(path.resolve())

    if rel:
        direct = Path(rel)
        if direct.is_file():
            hit = _ok(direct)
            if hit:
                return hit
        if root.is_dir():
            hit = _ok(root / rel)
            if hit:
                return hit

    if not root.is_dir():
        return ""

    role_key = (role or "default").strip().lower() or "default"
    for cand in _storage_candidates(
        root, module=module, package_prefix=package_prefix, role=role_key
    ):
        hit = _ok(cand)
        if hit:
            return hit

    # Broader scan — any module fixtures under AItest/E2ETest
    e2e_root = root / "AItest" / "E2ETest"
    if e2e_root.is_dir():
        preferred = (
            f"storageState-{role_key}.json",
            "storageState.json",
            "storageState-default.json",
        )
        found: list[Path] = []
        for cand in e2e_root.rglob("storageState*.json"):
            if cand.is_file():
                found.append(cand)
        for name in preferred:
            for cand in found:
                if cand.name.lower() == name.lower():
                    hit = _ok(cand)
                    if hit:
                        return hit
        for cand in found:
            hit = _ok(cand)
            if hit:
                return hit

    auth_dir = root / ".ai-test" / "auth"
    if auth_dir.is_dir():
        for cand in sorted(auth_dir.glob("storageState*.json")):
            hit = _ok(cand)
            if hit:
                return hit

    return ""


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

    # 0) Deterministic SUT mine → materialize missing .ai-test/auth/{role}.json (no AITest UI)
    try:
        from app.services.e2e_auth_sut_mine import materialize_mined_auth_artifacts

        mined_roles = materialize_mined_auth_artifacts(root)
        if mined_roles:
            discovery.notes.append(
                f"Auto auth từ SUT (i18n/JHipster/.env mine): {', '.join(mined_roles)}"
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("sut auth mine failed: %s", exc)

    # 1) AI seed / mined artifacts (primary — no AITest UI / no manual .env required)
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
            "Sẵn sàng auth (ưu tiên .ai-test/auth từ SUT-mine/AI seed; fallback .env/storageState)."
        )
    else:
        discovery.notes.append(
            "Chưa có auth. Hệ thống sẽ auto-mine JHipster/i18n/.env — "
            "hoặc chạy «Seed auth (AI)» nếu app có register công khai."
        )
    return discovery


def infer_role_from_text(*parts: str) -> str | None:
    blob = " ".join(p or "" for p in parts).lower()
    for role in (
        "admin",
        "administrator",
        "director",
        "investigator",
        "manager",
        "staff",
        "user",
        "guest",
        "viewer",
        "editor",
        "head",
    ):
        if re.search(rf"\b{re.escape(role)}\b", blob):
            if role == "administrator":
                return "admin"
            return role
    m = re.search(r"role\s*[:=]\s*([a-z][\w-]{1,24})", blob)
    if m:
        return m.group(1)
    return None


def parse_roles_list(*parts: str) -> list[str]:
    """Extract multi-role list from TC markers ``roles: a,b`` + primary authRole."""
    blob = "\n".join(p or "" for p in parts)
    found: list[str] = []
    primary = None
    m_role = re.search(r"(?im)^\s*authRole\s*[:=]\s*(\S+)\s*$", blob)
    if m_role:
        primary = m_role.group(1).strip().lower()
    m_roles = re.search(r"(?im)^\s*roles\s*[:=]\s*([^\n]+)\s*$", blob)
    if m_roles:
        for piece in re.split(r"[,|;/\s]+", m_roles.group(1)):
            slug = re.sub(r"[^a-z0-9_-]+", "-", piece.strip().lower()).strip("-")
            if slug and slug not in found:
                found.append(slug)
    if primary:
        found = [primary] + [r for r in found if r != primary]
    if not found:
        inferred = infer_role_from_text(*parts)
        if inferred:
            found.append(inferred)
    return found


def _env_role_slug(role: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", (role or "default").strip()).upper() or "DEFAULT"


def auth_env_for_role(discovery: AuthDiscovery, role: str | None = None) -> dict[str, str]:
    """Flat env for the preferred role + E2E_<ROLE>_* for every known role with creds."""
    profile = discovery.pick(role)
    out: dict[str, str] = {}
    if profile:
        if profile.username:
            out["E2E_USERNAME"] = profile.username
        if profile.password:
            out["E2E_PASSWORD"] = profile.password
        if profile.role and profile.role != "default":
            out["E2E_ROLE"] = profile.role
        if profile.storage_state_rel and profile.storage_state_valid:
            out["E2E_STORAGE_STATE"] = profile.storage_state_rel

    # Multi-role: always export scoped keys so dual-actor Specs can switch.
    for r in discovery.roles:
        if not (r.username and r.password):
            continue
        slug = _env_role_slug(r.role)
        out[f"E2E_{slug}_USERNAME"] = r.username
        out[f"E2E_{slug}_PASSWORD"] = r.password
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

    shared = e2e_shared_root(package_prefix=package_prefix)
    # Suite-wide storage under _shared — config under {Req}/{TC} points here via relative path
    for f in files or []:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        low = p.lower()
        if "/_shared/" in low:
            # Keep writing into the shared tree already present in the bundle
            idx = low.find("/_shared/")
            shared = p[: idx + len("/_shared")]
            break
    dest = f"{shared}/fixtures/storageState.json"
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
    _ = (project_root, storage_rel, module, e2e_module_root)
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
    from app.services.e2e_auth_seed import (
        is_invented_auth_username,
        load_auth_artifact,
        parse_auth_markers,
    )
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
                    if u and p and not is_invented_auth_username(u):
                        discovered["E2E_USERNAME"] = u
                        discovered["E2E_PASSWORD"] = p
                    elif is_invented_auth_username(u):
                        try:
                            ref_path.unlink(missing_ok=True)
                        except OSError:
                            pass
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
