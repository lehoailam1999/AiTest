"""
Deterministic SUT credential mining for E2E auth (no AI invent).

Sources (in priority order within this module):
1) cypress.env.json / playwright.env.json
2) i18n login hints (JHipster: tài khoản=\"admin\" / username=\"admin\")
3) application*.yml / appsettings*.json spring.security.user
4) JHipster fingerprint (.yo-rc.json) → admin/admin + user/user (+ known seed logins)

Never invent e2e_default / @aitest.local — only documented or framework-default accounts.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("aitest.e2e.auth_mine")

# JHipster / Forensic-style seed logins commonly created with password == login.
_JH_SEED_LOGINS = ("admin", "user", "director", "head", "investigator", "manager", "staff")

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


def is_jhipster_project(project_root: Path) -> bool:
    if (project_root / ".yo-rc.json").is_file():
        return True
    # Nested ClientApp / generator markers
    for cand in (
        project_root / "package.json",
        project_root / "src" / "Forensic" / "ClientApp" / "package.json",
    ):
        if not cand.is_file():
            continue
        try:
            raw = cand.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if "generator-jhipster" in raw or "jhipster" in raw.lower():
            return True
    return (project_root / ".yo-rc.json").is_file()


def _mine_cypress_env(root: Path) -> list[MinedCred]:
    out: list[MinedCred] = []
    for rel in (
        "cypress.env.json",
        "playwright.env.json",
        "src/test/javascript/cypress/cypress.env.json",
        "ClientApp/cypress.env.json",
    ):
        path = root / rel
        if not path.is_file():
            # also search one level of src/*/ClientApp
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        user = str(
            data.get("username")
            or data.get("user")
            or data.get("email")
            or data.get("adminUsername")
            or ""
        ).strip()
        password = str(
            data.get("password")
            or data.get("pass")
            or data.get("adminPassword")
            or ""
        ).strip()
        if user and password:
            out.append(
                MinedCred(
                    role=_role_for_username(user),
                    username=user,
                    password=password,
                    source=f"cypress-env:{rel}",
                )
            )
        # role-scoped keys
        for k, v in data.items():
            if not isinstance(v, str) or not v.strip():
                continue
            km = re.match(r"(?i)^(?:admin|user|director|head|investigator)(?:Username|User|Email)$", k)
            if not km:
                continue
            role = re.sub(r"(?i)(Username|User|Email)$", "", k).lower()
            pk = None
            for cand in (f"{role}Password", f"{role}Pass", "password"):
                if cand in data and str(data[cand]).strip():
                    pk = str(data[cand]).strip()
                    break
            if pk:
                out.append(
                    MinedCred(
                        role=_role_slug(role),
                        username=v.strip(),
                        password=pk,
                        source=f"cypress-env:{rel}",
                    )
                )
    return out


def _mine_i18n_hints(root: Path) -> list[MinedCred]:
    out: list[MinedCred] = []
    # Prefer known JHipster/.NET ClientApp paths (fast) before broad glob.
    candidates: list[Path] = []
    for rel in (
        "src/Forensic/ClientApp/src/i18n/vi/global.json",
        "src/Forensic/ClientApp/src/i18n/en/global.json",
        "src/main/webapp/i18n/vi/global.json",
        "src/main/webapp/i18n/en/global.json",
        "ClientApp/src/i18n/vi/global.json",
        "ClientApp/src/i18n/en/global.json",
    ):
        p = root / rel
        if p.is_file():
            candidates.append(p)
    if not candidates:
        for path in root.glob("**/i18n/**/global.json"):
            if "node_modules" in path.parts or "bin" in path.parts:
                continue
            candidates.append(path)
            if len(candidates) >= 6:
                break

    seen: set[tuple[str, str]] = set()
    for path in candidates:
        try:
            if path.stat().st_size > 500_000:
                continue
            raw = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for m in _I18N_CRED_RE.finditer(raw):
            user = m.group("user").strip()
            password = m.group("pass").strip()
            key = (user.lower(), password)
            if not user or not password or key in seen:
                continue
            seen.add(key)
            out.append(
                MinedCred(
                    role=_role_for_username(user),
                    username=user,
                    password=password,
                    source=f"i18n:{path.name}",
                )
            )
        if len(out) >= 8:
            break
    return out


def _mine_spring_yml(root: Path) -> list[MinedCred]:
    out: list[MinedCred] = []
    for pat in ("**/application*.yml", "**/application*.yaml"):
        for path in root.glob(pat):
            try:
                if path.stat().st_size > 200_000:
                    continue
                raw = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            m = _SPRING_USER_RE.search(raw)
            if m:
                out.append(
                    MinedCred(
                        role=_role_for_username(m.group("user")),
                        username=m.group("user").strip(),
                        password=m.group("pass").strip(),
                        source=f"yml:{path.name}",
                    )
                )
            if len(out) >= 4:
                return out
    return out


def _mine_appsettings(root: Path) -> list[MinedCred]:
    out: list[MinedCred] = []
    for pat in ("**/appsettings*.json",):
        for path in root.glob(pat):
            # skip bin/obj
            parts = {p.lower() for p in path.parts}
            if "bin" in parts or "obj" in parts or "node_modules" in parts:
                continue
            try:
                if path.stat().st_size > 300_000:
                    continue
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            # Common shapes: Authentication: { Username, Password } or SeedUsers
            for section in (
                data.get("Authentication"),
                data.get("SeedUsers"),
                data.get("E2E"),
                data.get("TestUsers"),
            ):
                if not isinstance(section, dict):
                    continue
                user = str(section.get("Username") or section.get("User") or "").strip()
                password = str(section.get("Password") or section.get("Pass") or "").strip()
                if user and password:
                    out.append(
                        MinedCred(
                            role=_role_for_username(user),
                            username=user,
                            password=password,
                            source=f"appsettings:{path.name}",
                        )
                    )
            if len(out) >= 4:
                return out
    return out


def _mine_jhipster_defaults(root: Path) -> list[MinedCred]:
    if not is_jhipster_project(root):
        return []
    out = [
        MinedCred("admin", "admin", "admin", "jhipster-default"),
        MinedCred("user", "user", "user", "jhipster-default"),
        MinedCred("default", "admin", "admin", "jhipster-default"),
    ]
    # Extra Forensic/JHipster-dotnet seed logins (password == login is framework convention)
    for login in ("director", "head", "investigator"):
        out.append(MinedCred(login, login, login, "jhipster-seed-login"))
    return out


def mine_sut_credentials(project_root: str | Path) -> list[MinedCred]:
    """
    Return unique role→cred mappings discovered from the SUT tree.
    Later sources do not override earlier ones for the same role.
    """
    root = Path(project_root)
    if not root.is_dir():
        return []

    ordered: list[MinedCred] = []
    ordered.extend(_mine_cypress_env(root))
    ordered.extend(_mine_i18n_hints(root))
    # Heavy globs only when we still lack a usable default/admin pair
    have_admin = any(c.role == "admin" for c in ordered)
    if not have_admin:
        ordered.extend(_mine_spring_yml(root))
        ordered.extend(_mine_appsettings(root))
    ordered.extend(_mine_jhipster_defaults(root))

    by_role: dict[str, MinedCred] = {}
    for cred in ordered:
        role = _role_slug(cred.role)
        if role not in by_role:
            by_role[role] = MinedCred(role, cred.username, cred.password, cred.source)
            logger.info(
                "auth-mine role=%s user=%s source=%s",
                role,
                cred.username,
                cred.source,
            )
    return list(by_role.values())


def materialize_mined_auth_artifacts(
    project_root: str | Path,
    *,
    roles: list[str] | None = None,
) -> list[str]:
    """
    Persist mined creds into ``.ai-test/auth/{role}.json`` (idempotent).
    Returns list of roles written or already present.
    """
    from app.services.e2e_auth_seed import (
        is_invented_auth_username,
        load_auth_artifact,
        save_auth_artifact,
    )

    root = Path(project_root)
    want = {_role_slug(r) for r in (roles or []) if (r or "").strip()}
    written: list[str] = []
    for cred in mine_sut_credentials(root):
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
