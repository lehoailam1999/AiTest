"""
Single source of truth for E2E auth strategy.

StorageState-first (product default for apps WITH login):
- storage: config uses fixtures/storageState.json + globalSetup seed; feature Specs no UI login
- ui_helper: no storageState in config; inject ensureAuthenticated
- none: Login/Logout TCs — UI-driven, neither storage nor helper inject
- public: app has no login wall (SRS/DOM) — never storage / globalSetup / ensureAuthenticated
"""

from __future__ import annotations

import re
from typing import Literal

AuthMode = Literal["storage", "ui_helper", "none", "public"]

# Negative forms — public/anonymous access (not a Login journey).
_PUBLIC_NO_AUTH_RE = re.compile(
    r"(?i)"
    r"không\s*(?:yêu\s*cầu|cần)\s*đăng[\s_-]*nhập|"
    r"không\s*đăng[\s_-]*nhập.{0,60}(?:vẫn|xem\s*được|được\s*xem)|"
    r"(?:vẫn|được).{0,40}không\s*đăng[\s_-]*nhập|"
    r"không\s*có\s*(?:phân\s*quyền|xác\s*thực)|"
    r"without\s+(?:login|auth|authentication)|"
    r"no\s+login\s+required|"
    r"unauthenticated|anonymous|"
    r"public\s+access|"
    r"ngoài\s*phạm\s*vi.{0,120}đăng[\s_-]*nhập|"
    r"out\s*of\s*scope.{0,120}(?:login|sign[\s_-]*in|auth)"
)

# «không đăng nhập» / «không cần đăng nhập» — strip before Login-TC keyword match
# so feature steps like «PUBLIC — không đăng nhập» are not treated as Login journeys.
_NEGATED_LOGIN_PHRASE_RE = re.compile(
    r"(?i)không\s*(?:yêu\s*cầu\s*|cần\s*)?đăng[\s_-]*nhập"
)

# Feature journeys that mention login only as context (not Login/Logout TCs).
_POST_LOGIN_FEATURE_RE = re.compile(
    r"(?i)"
    r"(?:after|post|before|without)[\s_-]*(?:login|auth)|"
    r"(?:leaves?|left|exit|thoát|rời)\s*(?:the\s*)?(?:login|/login)|"
    r"session\s*(?:ready|established)|"
    r"authenticated\s+session|"
    r"sau\s*(?:khi\s*)?đăng[\s_-]*nhập|"
    r"đã\s*đăng[\s_-]*nhập|"
    r"post[\s_-]*auth"
)

# Path segments that ARE login journeys — not modules like AuthSmoke / auth-smoke.spec.
_LOGIN_PATH_RE = re.compile(
    r"(?i)"
    r"(?:^|/)(?:login|logout|signin|sign-in|signup|sign-up)"
    r"(?:[._\-/]|$)|"
    r"(?:^|/)auth(?:\.setup|/login|/logout|/signin)(?:[._\-/]|$)|"
    r"(?:^|/)auth/(?:login|logout|signin|sign-in)"
)

_LOGIN_TC_RE = re.compile(
    r"(?:^|[\s/_-])(?:login|logout|signin|sign-in|signup|sign-up)(?:[\s/_-]|$)|"
    r"đăng[\s_-]*nhập|đăng[\s_-]*xuất",
    re.IGNORECASE,
)

_LOGIN_WALL_DOM_RE = re.compile(
    r"(?i)"
    r"đăng\s*nhập|sign\s*in|log\s*in|"
    r"mật\s*khẩu|password|"
    r"type\s*=\s*[\"']password[\"']|"
    r"getByLabel\([^\)]*password|"
    r"textbox[^\n]{0,40}(?:email|password|username)"
)


def is_public_no_auth_signal(
    *,
    title: str = "",
    path: str = "",
    dom_snapshot: str = "",
    hints: str = "",
) -> bool:
    """
    True when the app/TC clearly does not require authentication.

    Only explicit SRS/TC wording counts. Do NOT infer PUBLIC from a landing/home
    DOM snapshot (many apps show nav without password fields until /login).
    """
    blob = f"{title or ''}\n{path or ''}\n{hints or ''}"
    if _PUBLIC_NO_AUTH_RE.search(blob):
        return True
    # DOM with an explicit login wall must never be treated as public.
    dom = (dom_snapshot or "").strip()
    if dom and _LOGIN_WALL_DOM_RE.search(dom):
        return False
    return False


def is_login_or_auth_tc(title: str = "", path: str = "") -> bool:
    """True for Login/Logout/auth journeys that must stay UI-driven."""
    blob = f"{title or ''} {path or ''}".strip()
    if not blob:
        return False
    # Public-access / anonymous TCs must NOT be treated as Login journeys.
    if _PUBLIC_NO_AUTH_RE.search(blob):
        return False
    # «feature after login» / «sau khi đăng nhập» = feature TC, unless path is auth/*.
    if _POST_LOGIN_FEATURE_RE.search(blob) and not _LOGIN_PATH_RE.search(path or ""):
        return False
    # Strip negated «không đăng nhập» so remaining keywords decide (feature ≠ Login TC).
    cleaned = _NEGATED_LOGIN_PHRASE_RE.sub(" ", blob)
    if _LOGIN_TC_RE.search(cleaned):
        return True
    # File/route segments: login.spec.ts, auth/login/, … (not AuthSmoke / auth-smoke).
    return bool(_LOGIN_PATH_RE.search(path or "") or _LOGIN_PATH_RE.search(cleaned))


def resolve_auth_mode(
    *,
    use_storage: bool = False,
    has_valid_storage_json: bool = False,
    is_login_tc: bool = False,
    app_public: bool = False,
) -> AuthMode:
    """
    Resolve mutually exclusive auth mode.

    - Login TC → none (never stack storage + helper).
    - Public app / no-auth signal → public (overrides Desktop «Dùng storageState»).
    - Valid storage JSON or use_storage flag → storage.
    - Else → ui_helper.
    """
    if is_login_tc:
        return "none"
    if app_public:
        return "public"
    if has_valid_storage_json or use_storage:
        return "storage"
    return "ui_helper"


def wants_storage_state(mode: AuthMode) -> bool:
    return mode == "storage"


def wants_ui_auth_helper(mode: AuthMode) -> bool:
    return mode == "ui_helper"


def wants_no_auth_artifacts(mode: AuthMode) -> bool:
    """True when storageState / globalSetup / ensureAuthenticated must not appear."""
    return mode in ("none", "public")
