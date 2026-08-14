"""
Deterministic SUT credential mining for E2E auth (no AI invent, no product nouns).

SoT for *which* roles to persist:
  ``.ai-test/project.profile.json`` → ``auth.roles`` (optional ``auth.seedFiles``)
  plus the role the caller asked for (TC ``authRole``).

SoT for *credentials* (first hit wins per role):
  1) Files the profile lists (``auth.seedFiles``)
  2) Env / env-json under project root + ``playwrightRun.packageRoot``
  3) Generic E2E seed files under those roots (roles.json, *roles*.ts, .env.e2e)
  4) i18n login hints, then Spring/appsettings
  5) JHipster framework defaults (admin/user) only as last resort

Never invent e2e_default / @aitest.local or RBAC logins (director/staff/…).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("aitest.e2e.auth_mine")

_I18N_CRED_RE = re.compile(
    r"(?:tài\s*khoản|username|login|user)\s*=\s*\\\"?(?P<user>[^\\\"'\\s><]+)\\\"?"
    r"[^.]{0,40}?"
    r"(?:mật\s*khẩu|password|pass)\s*=\s*\\\"?(?P<pass>[^\\\"'\\s><]+)\\\"?",
    re.IGNORECASE | re.DOTALL,
)

_SPRING_USER_RE = re.compile(
    r"spring\s*:\s*security\s*:.*?user\s*:\s*"
    r"name\s*:\s*[\"']?(?P<user>[^\s\"'#]+)[\"']?.*"
    r"password\s*:\s*[\"']?(?P<pass>[^\s\"'#]+)[\"']?",
    re.IGNORECASE | re.DOTALL,
)

_E2E_USER_FALLBACK_RE = re.compile(
    r"E2E_([A-Z][A-Z0-9]*)_USERNAME\s*\?\?\s*['\"]([^'\"]+)['\"]",
)
_E2E_PASS_FALLBACK_RE = re.compile(
    r"E2E_([A-Z][A-Z0-9]*)_PASSWORD\s*\?\?\s*['\"]([^'\"]+)['\"]",
)
_E2E_SEED_PASS_RE = re.compile(
    r"E2E_SEED_PASSWORD\s*\?\?\s*['\"]([^'\"]+)['\"]",
)
_ENV_PAIR_RE = re.compile(
    r"^(?:E2E|TEST|PLAYWRIGHT)_(?:ROLE_)?([A-Z][A-Z0-9]*)_(USERNAME|USER|EMAIL|PASSWORD|PASS)\s*=\s*(.+)$",
    re.IGNORECASE | re.MULTILINE,
)

_SKIP_DIR = frozenset({"node_modules", "dist", "bin", "obj", ".git", "coverage"})
_PRIMARY_ROLES = frozenset({"admin", "default"})


@dataclass(frozen=True)
class MinedCred:
    role: str
    username: str
    password: str
    source: str


def _role_slug(role: str) -> str:
    s = re.sub(r"[^a-z0-9_-]+", "-", (role or "default").strip().lower()).strip("-")
    return s or "default"


def _role_for_username(username: str) -> str:
    u = (username or "").strip().lower()
    if u in ("admin", "administrator", "root"):
        return "admin"
    if u in ("user", "users"):
        return "user"
    return _role_slug(u) if u else "default"


def load_aitest_profile(project_root: str | Path) -> dict:
    path = Path(project_root) / ".ai-test" / "project.profile.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _search_roots(root: Path, profile: dict) -> list[Path]:
    roots: list[Path] = [root]
    pkg = str((profile.get("playwrightRun") or {}).get("packageRoot") or "").strip()
    if pkg:
        p = Path(pkg) if Path(pkg).is_absolute() else (root / pkg)
        try:
            if p.is_dir():
                resolved = p.resolve()
                if resolved not in {r.resolve() for r in roots}:
                    roots.append(resolved)
        except OSError:
            pass
    return roots


def is_jhipster_project(project_root: Path) -> bool:
    if (project_root / ".yo-rc.json").is_file():
        return True
    candidates = [
        project_root / "package.json",
        project_root / "ClientApp" / "package.json",
        project_root / "src" / "main" / "webapp" / "package.json",
    ]
    src = project_root / "src"
    if src.is_dir():
        try:
            for child in src.iterdir():
                if child.is_dir():
                    candidates.append(child / "ClientApp" / "package.json")
        except OSError:
            pass
    for cand in candidates:
        if not cand.is_file():
            continue
        try:
            raw = cand.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if "generator-jhipster" in raw or "jhipster" in raw.lower():
            return True
    return False


def _skip_path(path: Path) -> bool:
    return bool(_SKIP_DIR.intersection({p.lower() for p in path.parts}))


def _read_text(path: Path, max_bytes: int = 200_000) -> str:
    try:
        if path.stat().st_size > max_bytes:
            return ""
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def _cred(role: str, user: str, password: str, source: str) -> MinedCred | None:
    u, p = (user or "").strip(), (password or "").strip()
    if not u or not p:
        return None
    return MinedCred(_role_slug(role), u, p, source)


def _parse_env_text(raw: str, source: str) -> list[MinedCred]:
    pairs: dict[str, dict[str, str]] = {}
    for m in _ENV_PAIR_RE.finditer(raw or ""):
        role, kind, val = m.group(1), m.group(2).upper(), m.group(3).strip().strip("'\"")
        slot = pairs.setdefault(role.upper(), {})
        if kind in ("USERNAME", "USER", "EMAIL"):
            slot["user"] = val
        else:
            slot["pass"] = val
    out: list[MinedCred] = []
    for role, slot in pairs.items():
        c = _cred(_role_slug(role), slot.get("user", ""), slot.get("pass", ""), source)
        if c:
            out.append(c)
    return out


def _parse_json_creds(data: object, source: str) -> list[MinedCred]:
    out: list[MinedCred] = []
    if not isinstance(data, dict):
        return out
    user = str(
        data.get("username")
        or data.get("user")
        or data.get("email")
        or data.get("adminUsername")
        or ""
    ).strip()
    password = str(
        data.get("password") or data.get("pass") or data.get("adminPassword") or ""
    ).strip()
    c = _cred(_role_for_username(user) if user else "default", user, password, source)
    if c:
        out.append(c)
    for k, v in data.items():
        if isinstance(v, str) and v.strip():
            km = re.match(r"(?i)^([a-z][a-z0-9_-]{1,32})(?:Username|User|Email)$", k)
            if not km:
                continue
            role = re.sub(r"(?i)(Username|User|Email)$", "", k)
            pk = ""
            for cand in (f"{role}Password", f"{role}Pass", "password"):
                if cand in data and str(data[cand]).strip():
                    pk = str(data[cand]).strip()
                    break
            c = _cred(role, v, pk, source)
            if c:
                out.append(c)
            continue
        if not isinstance(v, dict):
            continue
        u = str(v.get("username") or v.get("user") or v.get("email") or "").strip()
        p = str(v.get("password") or v.get("pass") or "").strip()
        c = _cred(str(k), u, p, source)
        if c:
            out.append(c)
    return out


def _parse_ts_e2e_fallbacks(raw: str, source: str) -> list[MinedCred]:
    seed_pass = ""
    m_seed = _E2E_SEED_PASS_RE.search(raw or "")
    if m_seed:
        seed_pass = m_seed.group(1).strip()
    users = {k.upper(): v for k, v in _E2E_USER_FALLBACK_RE.findall(raw or "")}
    passwords = {k.upper(): v for k, v in _E2E_PASS_FALLBACK_RE.findall(raw or "")}
    out: list[MinedCred] = []
    for role_key, username in users.items():
        c = _cred(role_key, username, passwords.get(role_key) or seed_pass, source)
        if c:
            out.append(c)
    return out


def _parse_any_file(path: Path) -> list[MinedCred]:
    raw = _read_text(path)
    if not raw.strip():
        return []
    src = path.name
    low = path.suffix.lower()
    if low == ".json":
        try:
            data = json.loads(raw)
        except Exception:
            return []
        return _parse_json_creds(data, f"json:{src}")
    if path.name.startswith(".env") or low in {".env", ".local"}:
        return _parse_env_text(raw, f"env:{src}")
    if low in {".ts", ".js", ".mjs", ".cjs"}:
        return _parse_ts_e2e_fallbacks(raw, f"seed:{src}")
    out = _parse_env_text(raw, f"text:{src}")
    out.extend(_parse_ts_e2e_fallbacks(raw, f"text:{src}"))
    return out


def _iter_generic_seed_files(search_root: Path) -> list[Path]:
    names = (
        "cypress.env.json",
        "playwright.env.json",
        ".env",
        ".env.local",
        ".env.e2e",
        ".env.test",
        "roles.json",
        "support/roles.json",
        "support/config/roles.ts",
        "support/config/roles.json",
        "fixtures/roles.json",
        "fixtures/auth/roles.json",
    )
    found: list[Path] = []
    for rel in names:
        p = search_root / rel
        if p.is_file() and not _skip_path(p):
            found.append(p)
    try:
        for pat in ("support/**/roles.ts", "support/**/roles.js", "support/**/roles.json"):
            for p in search_root.glob(pat):
                if p.is_file() and not _skip_path(p) and p not in found:
                    found.append(p)
                    if len(found) >= 16:
                        return found
    except OSError:
        pass
    return found


def _mine_i18n_hints(root: Path) -> list[MinedCred]:
    out: list[MinedCred] = []
    candidates: list[Path] = []
    for rel in (
        "src/main/webapp/i18n/vi/global.json",
        "src/main/webapp/i18n/en/global.json",
        "ClientApp/src/i18n/vi/global.json",
        "ClientApp/src/i18n/en/global.json",
    ):
        p = root / rel
        if p.is_file():
            candidates.append(p)
    src = root / "src"
    if src.is_dir() and not candidates:
        try:
            for child in src.iterdir():
                for lang in ("vi", "en"):
                    p = child / "ClientApp" / "src" / "i18n" / lang / "global.json"
                    if p.is_file():
                        candidates.append(p)
        except OSError:
            pass
    if not candidates:
        for path in root.glob("**/i18n/**/global.json"):
            if _skip_path(path):
                continue
            candidates.append(path)
            if len(candidates) >= 6:
                break
    seen: set[tuple[str, str]] = set()
    for path in candidates:
        raw = _read_text(path, max_bytes=500_000)
        for m in _I18N_CRED_RE.finditer(raw):
            user, password = m.group("user").strip(), m.group("pass").strip()
            key = (user.lower(), password)
            if not user or not password or key in seen:
                continue
            seen.add(key)
            c = _cred(_role_for_username(user), user, password, f"i18n:{path.name}")
            if c:
                out.append(c)
        if len(out) >= 8:
            break
    return out


def _mine_spring_yml(root: Path) -> list[MinedCred]:
    out: list[MinedCred] = []
    for pat in ("**/application*.yml", "**/application*.yaml"):
        for path in root.glob(pat):
            if _skip_path(path):
                continue
            raw = _read_text(path)
            m = _SPRING_USER_RE.search(raw)
            if m:
                c = _cred(
                    _role_for_username(m.group("user")),
                    m.group("user"),
                    m.group("pass"),
                    f"yml:{path.name}",
                )
                if c:
                    out.append(c)
            if len(out) >= 4:
                return out
    return out


def _mine_appsettings(root: Path) -> list[MinedCred]:
    out: list[MinedCred] = []
    for path in root.glob("**/appsettings*.json"):
        if _skip_path(path):
            continue
        raw = _read_text(path, max_bytes=300_000)
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        for section in (
            data.get("Authentication"),
            data.get("SeedUsers"),
            data.get("E2E"),
            data.get("TestUsers"),
        ):
            if isinstance(section, dict):
                out.extend(_parse_json_creds(section, f"appsettings:{path.name}"))
        if len(out) >= 4:
            return out
    return out


def _mine_jhipster_defaults(root: Path) -> list[MinedCred]:
    if not is_jhipster_project(root):
        return []
    return [
        MinedCred("admin", "admin", "admin", "jhipster-default"),
        MinedCred("user", "user", "user", "jhipster-default"),
        MinedCred("default", "admin", "admin", "jhipster-default"),
    ]


def mine_sut_credentials(project_root: str | Path) -> list[MinedCred]:
    """Unique role→cred mappings. Later sources do not override earlier ones."""
    root = Path(project_root)
    if not root.is_dir():
        return []
    profile = load_aitest_profile(root)
    ordered: list[MinedCred] = []

    for rel in (profile.get("auth") or {}).get("seedFiles") or []:
        rel_s = str(rel or "").strip().replace("\\", "/")
        if not rel_s or ".." in rel_s.split("/"):
            continue
        path = root / rel_s
        if path.is_file():
            ordered.extend(_parse_any_file(path))

    for search in _search_roots(root, profile):
        for path in _iter_generic_seed_files(search):
            ordered.extend(_parse_any_file(path))

    ordered.extend(_mine_i18n_hints(root))
    have_admin = any(c.role == "admin" for c in ordered)
    if not have_admin:
        ordered.extend(_mine_spring_yml(root))
        ordered.extend(_mine_appsettings(root))
    ordered.extend(_mine_jhipster_defaults(root))

    by_role: dict[str, MinedCred] = {}
    for cred in ordered:
        role = _role_slug(cred.role)
        if role not in by_role:
            by_role[role] = cred
            logger.info(
                "auth-mine role=%s user=%s source=%s",
                role,
                cred.username,
                cred.source,
            )
    return list(by_role.values())


def _roles_to_persist(
    mined: list[MinedCred],
    *,
    requested: list[str] | None,
    profile: dict,
) -> set[str]:
    """Write requested / profile roles, or every role mined from E2E seed files.

    Never dump a guessed RBAC cast (jhipster-default extras stay admin/default only).
    """
    want = {_role_slug(r) for r in (requested or []) if (r or "").strip()}
    want |= {
        _role_slug(r)
        for r in ((profile.get("auth") or {}).get("roles") or [])
        if str(r).strip()
    }
    if want:
        return want
    found = {c.role for c in mined}
    from_seed = {
        c.role
        for c in mined
        if c.source.startswith(("seed:", "json:", "env:"))
        or "roles.ts" in c.source
        or "roles.json" in c.source
    }
    if from_seed:
        return from_seed | (found & _PRIMARY_ROLES)
    keep = found & _PRIMARY_ROLES
    if keep:
        return keep
    if mined:
        return {mined[0].role}
    return set()


def materialize_mined_auth_artifacts(
    project_root: str | Path,
    *,
    roles: list[str] | None = None,
) -> list[str]:
    """
    Persist mined creds into ``.ai-test/auth/{role}.json`` (idempotent).
    Writes requested / profile ``auth.roles``, else every role from E2E seed files,
    else admin+default only.
    """
    from app.services.e2e_auth_seed import (
        is_invented_auth_username,
        load_auth_artifact,
        save_auth_artifact,
    )

    root = Path(project_root)
    profile = load_aitest_profile(root)
    mined = mine_sut_credentials(root)
    want = _roles_to_persist(mined, requested=roles, profile=profile)
    written: list[str] = []
    for cred in mined:
        if want and cred.role not in want:
            continue
        existing = load_auth_artifact(root, cred.role)
        if existing:
            written.append(cred.role)
            continue
        if is_invented_auth_username(cred.username):
            continue
        save_auth_artifact(
            root,
            role=cred.role,
            username=cred.username,
            password=cred.password,
            extra={"strategy": "sut-mine", "source": cred.source},
        )
        written.append(cred.role)
    return written
