"""
Phase 2 — Test Planner (Python mirror of desktop/src/lib/testPlanner).

Heuristic only: classify Unit | Integration | E2E | API and extract keywords
for retrieve. Keep in sync with TypeScript SoT when changing rules.
"""

from __future__ import annotations

import re
from typing import Any

PATH_MARKER_RE = re.compile(r"(?:^|[\n;,|])\s*path\s*[:=]\s*([^\n;,|]+)", re.I)

E2E_TYPE_RE = re.compile(r"\be2e\b|end[\s-]?to[\s-]?end|playwright|cypress|ui[\s-]?test", re.I)
UNIT_TYPE_RE = re.compile(r"\bunit\b|unittest|functional(?!\s*e2e)", re.I)
API_TYPE_RE = re.compile(r"\bapi\b|rest|graphql|http\s*test|contract", re.I)
INTEGRATION_TYPE_RE = re.compile(r"\bintegration\b|integ\b|component[\s-]?test", re.I)

UI_STEP_RE = re.compile(
    r"\b(click|tap|type|fill|navigate|goto|visit|open\s+page|locator|getby|"
    r"data-testid|data-cy|screenshot|browser|đăng\s*nhập|nhấn|điền|mở\s+trang)\b",
    re.I,
)
UNIT_STEP_RE = re.compile(
    r"\b(mock|stub|spy|arrange|act|assert|sut|service\.|repository\.|"
    r"unittest|jest\.|vitest|pytest|xunit)\b",
    re.I,
)
API_STEP_RE = re.compile(
    r"\b(GET|POST|PUT|PATCH|DELETE)\s+/[^\s]+|\bstatus\s*code\b|\bjson\s*body\b|"
    r"\bendpoint\b|\bswagger\b",
    re.I,
)

STOP_KEYWORDS = {
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "when",
    "then",
    "should",
    "must",
    "user",
    "test",
    "case",
    "step",
    "steps",
    "verify",
    "check",
    "ensure",
    "valid",
    "invalid",
    "success",
    "fail",
    "error",
    "và",
    "của",
    "cho",
    "khi",
    "thì",
}


def _blob(tc: dict[str, Any]) -> str:
    parts = [
        tc.get("title"),
        tc.get("type"),
        tc.get("module"),
        tc.get("precondition"),
        tc.get("steps"),
        tc.get("expectedResult") or tc.get("expected_result"),
        tc.get("testData") or tc.get("test_data"),
    ]
    return "\n".join(str(p).strip() for p in parts if p and str(p).strip())


def extract_feature_path(tc: dict[str, Any]) -> str | None:
    blob = "\n".join(
        str(p).strip()
        for p in (
            tc.get("testData") or tc.get("test_data"),
            tc.get("precondition"),
            tc.get("steps"),
            tc.get("title"),
        )
        if p and str(p).strip()
    )
    m = PATH_MARKER_RE.search(blob)
    if not m:
        return None
    p = m.group(1).strip().strip("\"'`")
    p = re.sub(r"^[a-z]+:\/\/[^/]+", "", p, flags=re.I)
    if not p.startswith("/"):
        p = f"/{p}"
    p = re.sub(r"/{2,}", "/", p)
    if not p or p == "/":
        return None
    return p


def _score_type_field(type_field: str | None) -> tuple[str | None, float, str | None]:
    t = (type_field or "").strip()
    if not t:
        return None, 0.0, None
    if E2E_TYPE_RE.search(t):
        return "E2E", 0.95, f"tc.type={t}"
    if API_TYPE_RE.search(t) and not re.search(r"e2e", t, re.I):
        return "API", 0.9, f"tc.type={t}"
    if INTEGRATION_TYPE_RE.search(t):
        return "Integration", 0.88, f"tc.type={t}"
    if UNIT_TYPE_RE.search(t) or re.fullmatch(r"functional", t, re.I):
        return "Unit", 0.85, f"tc.type={t}"
    return None, 0.0, None


def _keywords(tc: dict[str, Any], requirement: dict[str, Any] | None) -> list[str]:
    raw: list[str] = []
    mod = (tc.get("module") or "").strip()
    if mod:
        raw.append(mod)
    req = requirement or {}
    for f in req.get("featureNames") or req.get("feature_names") or []:
        if str(f).strip():
            raw.append(str(f).strip())
    text = " ".join(
        str(x)
        for x in (
            tc.get("title"),
            tc.get("module"),
            tc.get("steps"),
            tc.get("expectedResult") or tc.get("expected_result"),
            req.get("title"),
            req.get("summary"),
        )
        if x
    )
    for p in re.findall(r"\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b", text):
        raw.append(p)
    for w in re.findall(r"[A-Za-zÀ-ỹ_][A-Za-zÀ-ỹ0-9_]{2,}", text):
        if w.lower() in STOP_KEYWORDS:
            continue
        raw.append(w)
    path = extract_feature_path(tc)
    if path:
        for seg in path.split("/"):
            if len(seg) >= 2 and not seg.isdigit():
                raw.append(seg)
    seen: set[str] = set()
    out: list[str] = []
    for k in raw:
        key = k.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(k)
        if len(out) >= 12:
            break
    return out


def _guess_action(tc: dict[str, Any], keywords: list[str]) -> str:
    title = (tc.get("title") or "").strip()
    m = re.search(
        r"\b(create|update|delete|get|list|add|remove|login|logout|register|"
        r"submit|approve|reject|pay|cancel|tạo|sửa|xóa|xem|đăng\s*nhập)\b"
        r"\s+([A-Za-zÀ-ỹ0-9_\s]{2,40})",
        title,
        re.I,
    )
    if m:
        verb = re.sub(r"\s+", "", m.group(1))
        noun = "".join(
            w[:1].upper() + w[1:] for w in m.group(2).strip().split()[:3]
        )
        action = f"{verb[:1].upper()}{verb[1:]}{noun}"
        return re.sub(r"[^A-Za-z0-9]", "", action)[:48] or "Execute"
    for k in keywords:
        if re.search(r"[A-Z][a-z]+[A-Z]", k):
            return k[:48]
    mod = (tc.get("module") or "").strip()
    if mod:
        return f"{mod}Action"[:48]
    return "Execute"


def analyze_intent(
    tc: dict[str, Any],
    requirement: dict[str, Any] | None = None,
) -> dict[str, Any]:
    reasons: list[str] = []
    blob = _blob(tc)
    feature_path = extract_feature_path(tc)
    keywords = _keywords(tc, requirement)

    typed, conf, reason = _score_type_field(tc.get("type"))
    if typed and conf >= 0.85:
        if reason:
            reasons.append(reason)
        if feature_path:
            reasons.append(f"path={feature_path}")
        return {
            "testType": typed,
            "confidence": conf,
            "reasons": reasons,
            "featurePath": feature_path,
            "keywords": keywords,
            "actionHint": _guess_action(tc, keywords),
        }

    unit = e2e = api = integ = 0
    if feature_path:
        e2e += 3
        reasons.append(f"path hint {feature_path}")
    if UI_STEP_RE.search(blob):
        e2e += 3
        reasons.append("UI/browser steps")
    if UNIT_STEP_RE.search(blob):
        unit += 3
        reasons.append("unit/mock/assert signals")
    if API_STEP_RE.search(blob):
        api += 3
        reasons.append("HTTP/API signals")
    if re.search(r"\b(integration|across\s+services)\b", blob, re.I):
        integ += 2
        reasons.append("multi-service / integration cues")
    if re.search(r"\bplaywright\b|\bpage\.|locator\(", blob, re.I):
        e2e += 2
        reasons.append("playwright markers")

    scores = [
        ("E2E", e2e),
        ("API", api),
        ("Integration", integ),
        ("Unit", unit),
    ]
    scores.sort(key=lambda x: x[1], reverse=True)
    best_type, best_n = scores[0]
    test_type = best_type if best_n > 0 else "Unit"
    if best_n == 0:
        reasons.append("default Unit (no strong signal)")
    if typed and best_n > 0 and scores[1][1] == best_n:
        test_type = typed
        reasons.append("tie-break via tc.type")

    confidence = min(0.95, 0.45 + max(best_n, 1) * 0.12)
    return {
        "testType": test_type,
        "confidence": confidence,
        "reasons": reasons,
        "featurePath": feature_path,
        "keywords": keywords,
        "actionHint": _guess_action(tc, keywords),
    }


def plan_from_test_case(
    tc: dict[str, Any],
    *,
    requirement: dict[str, Any] | None = None,
    force_test_type: str | None = None,
) -> dict[str, Any]:
    intent = analyze_intent(tc, requirement)
    test_type = force_test_type or intent["testType"]
    module = (
        (tc.get("module") or "").strip()
        or (
            (requirement or {}).get("featureNames")
            or (requirement or {}).get("feature_names")
            or [None]
        )[0]
        or (intent["keywords"][0] if intent["keywords"] else None)
        or "Default"
    )
    if isinstance(module, str):
        module = module.strip() or "Default"
    else:
        module = "Default"

    hints: dict[str, Any] = {
        "confidence": intent["confidence"],
        "reasons": intent["reasons"],
        "featurePath": intent.get("featurePath"),
    }
    if test_type == "E2E":
        hints["e2eStack"] = "playwright"

    return {
        "testType": test_type,
        "module": module,
        "action": intent.get("actionHint") or "Execute",
        "keywords": intent["keywords"],
        "hints": hints,
    }
