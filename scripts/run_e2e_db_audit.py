from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
API_BASE = "http://127.0.0.1:5088/api"
PROJECT_ID = "76fc4541-1ec1-4319-8f75-8f511f5ca70e"
PROJECT_ROOT = "D:/Xlab/Forensic/forensic"
TIMEOUT_SEC = int(os.getenv("AITEST_AUDIT_TIMEOUT_SEC", "45"))
MAX_CASES = int(os.getenv("AITEST_AUDIT_MAX_CASES", "65"))


def _safe_print(msg: str) -> None:
    try:
        print(msg)
    except UnicodeEncodeError:
        out = msg.encode("cp1252", "replace").decode("cp1252", "replace")
        print(out)


def _api(path: str, token: str, *, method: str = "GET", body: dict | None = None) -> dict:
    data = None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{API_BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "ignore")
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"errors": [raw[:2000] or f"HTTP {exc.code}"]}
        payload["_http_status"] = exc.code
        return payload
    except Exception as exc:  # timeout / connection reset
        return {"errors": [f"request_failed: {exc}"], "_http_status": 599}


def _get_token() -> str:
    sys.path.insert(0, str(ROOT / "api"))
    from app.config import get_settings  # type: ignore
    from app.database import SessionLocal  # type: ignore
    from app.models.user import User  # type: ignore
    from app.services.auth_service import create_access_token  # type: ignore

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.deleted_at.is_(None)).first()
        if user is None:
            raise RuntimeError("No active user found in DB")
        token, _ = create_access_token(get_settings(), user)
        return token
    finally:
        db.close()


def _extract_errors(payload: dict) -> str:
    errs = payload.get("errors")
    if isinstance(errs, list) and errs:
        return "; ".join(str(x) for x in errs)
    if isinstance(payload.get("detail"), str):
        return str(payload["detail"])
    return json.dumps(payload)[:1200]


def main() -> int:
    token = _get_token()
    project = _api(f"/projects/{PROJECT_ID}", token)
    if project.get("_http_status"):
        print("project fetch failed:", _extract_errors(project))
        return 2
    target_url = (
        ((project.get("meta") or {}).get("e2e") or {}).get("targetUrl")
        or "http://localhost:4200"
    )
    _safe_print(f"project={PROJECT_ID}")
    _safe_print(f"target_url={target_url}")

    tcs_payload = _api(
        f"/testcases?projectId={PROJECT_ID}&reviewStatus=Approved&page=1&pageSize=200",
        token,
    )
    if tcs_payload.get("_http_status"):
        print("testcase fetch failed:", _extract_errors(tcs_payload))
        return 2
    all_cases = tcs_payload.get("items") or []
    e2e_cases = []
    for tc in all_cases:
        tc_type = str(tc.get("type") or "").lower()
        if "e2e" in tc_type or "end" in tc_type:
            e2e_cases.append(tc)
    if not e2e_cases:
        print("No approved E2E test cases found.")
        return 0

    if MAX_CASES > 0:
        e2e_cases = e2e_cases[:MAX_CASES]
    _safe_print(
        f"approved_total={len(all_cases)} e2e_total={len(e2e_cases)} timeout={TIMEOUT_SEC}s"
    )

    generated_by_module: dict[str, list[dict]] = defaultdict(list)
    gen_errors: list[tuple[str, str, str]] = []
    gen_ok = 0

    for idx, tc in enumerate(e2e_cases, start=1):
        body = {
            "projectId": PROJECT_ID,
            "testCaseId": tc["id"],
            "projectRoot": PROJECT_ROOT,
            "targetUrl": target_url,
            "skipAuthSeed": True,
            "usePlaywrightInspect": False,
            "projectRules": "",
            "projectRulesSource": "none",
        }
        res = _api("/generate-e2e", token, method="POST", body=body)
        title = str(tc.get("title") or tc["id"])
        module = str(tc.get("module") or "(none)")
        if res.get("_http_status"):
            msg = _extract_errors(res)
            gen_errors.append((tc["id"], title, msg))
            _safe_print(f"[GEN FAIL {idx}/{len(e2e_cases)}] {tc['id']} :: {msg[:220]}")
            continue
        files = res.get("files") or []
        if not files:
            gen_errors.append((tc["id"], title, "No files generated"))
            _safe_print(f"[GEN FAIL {idx}/{len(e2e_cases)}] {tc['id']} :: no files")
            continue
        gen_ok += 1
        generated_by_module[module].extend(files)
        _safe_print(f"[GEN OK {idx}/{len(e2e_cases)}] {tc['id']} files={len(files)} module={module}")

    verify_errors: list[tuple[str, str]] = []
    verify_ok = 0
    for module, files in generated_by_module.items():
        vbody = {
            "projectId": PROJECT_ID,
            "projectRoot": PROJECT_ROOT,
            "module": module if module != "(none)" else "",
            "files": files,
            "targetUrl": target_url,
            "healFailures": False,
        }
        vres = _api("/e2e-sandbox-module", token, method="POST", body=vbody)
        if vres.get("_http_status"):
            verify_errors.append((module, _extract_errors(vres)))
            _safe_print(f"[VERIFY FAIL] module={module} :: {_extract_errors(vres)[:240]}")
            continue
        status = str(vres.get("status") or "")
        if status.upper() == "PASSED":
            verify_ok += 1
            _safe_print(f"[VERIFY OK] module={module}")
        else:
            msg = str(vres.get("log") or vres.get("errorLog") or status or "FAILED")
            verify_errors.append((module, msg[:1200]))
            _safe_print(f"[VERIFY FAIL] module={module} :: {msg[:240]}")

    _safe_print("\n=== SUMMARY ===")
    _safe_print(f"gen_ok={gen_ok} gen_fail={len(gen_errors)}")
    _safe_print(f"verify_ok={verify_ok} verify_fail={len(verify_errors)}")

    if gen_errors:
        c = Counter()
        for _tcid, _title, err in gen_errors:
            if "E2E_GROUNDING" in err:
                c["E2E_GROUNDING"] += 1
            elif "journey enforce" in err.lower():
                c["journey_enforce"] += 1
            elif "bad escape \\u" in err:
                c["bad_escape_u"] += 1
            else:
                c["other_gen"] += 1
        _safe_print(f"gen_error_buckets={dict(c)}")
    if verify_errors:
        c2 = Counter()
        for _m, err in verify_errors:
            low = err.lower()
            if "preconditionfailed" in low and "@playwright/test" in low:
                c2["pw_missing"] += 1
            elif "preconditionfailed" in low and "storagestate" in low:
                c2["storage_missing"] += 1
            elif "no tests found" in low:
                c2["no_tests_found"] += 1
            else:
                c2["other_verify"] += 1
        _safe_print(f"verify_error_buckets={dict(c2)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
