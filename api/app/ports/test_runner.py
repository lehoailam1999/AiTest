"""Test runner parsers — multi-stack (W3). Desktop may mirror; BE stores summaries."""

from __future__ import annotations

import re
from typing import Callable


def _empty(exit_code: int) -> dict:
    status = "Passed" if exit_code == 0 else "Failed"
    return {
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "total": 0,
        "status": status,
        "exitCode": exit_code,
    }


def parse_pytest(stdout: str, stderr: str, exit_code: int) -> dict:
    text = f"{stdout}\n{stderr}"
    m = re.search(
        r"=+\s*(?:(\d+)\s+passed)?(?:,\s*)?(?:(\d+)\s+failed)?(?:,\s*)?(?:(\d+)\s+skipped)?",
        text,
    )
    if not m:
        return _empty(exit_code)
    passed = int(m.group(1) or 0)
    failed = int(m.group(2) or 0)
    skipped = int(m.group(3) or 0)
    return {
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "total": passed + failed + skipped,
        "status": "Passed" if failed == 0 and exit_code == 0 else "Failed",
        "exitCode": exit_code,
    }


def parse_jest(stdout: str, stderr: str, exit_code: int) -> dict:
    text = f"{stdout}\n{stderr}"
    # Tests:       1 failed, 2 passed, 3 total
    m = re.search(
        r"Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+passed,\s*)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+total",
        text,
    )
    if not m:
        return _empty(exit_code)
    failed = int(m.group(1) or 0)
    passed = int(m.group(2) or 0)
    skipped = int(m.group(3) or 0)
    total = int(m.group(4) or 0)
    return {
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "total": total or (passed + failed + skipped),
        "status": "Passed" if failed == 0 and exit_code == 0 else "Failed",
        "exitCode": exit_code,
    }


def parse_go_test(stdout: str, stderr: str, exit_code: int) -> dict:
    text = f"{stdout}\n{stderr}"
    passed = len(re.findall(r"^--- PASS:", text, re.M))
    failed = len(re.findall(r"^--- FAIL:", text, re.M))
    skipped = len(re.findall(r"^--- SKIP:", text, re.M))
    if passed + failed + skipped == 0:
        return _empty(exit_code)
    return {
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "total": passed + failed + skipped,
        "status": "Passed" if failed == 0 and exit_code == 0 else "Failed",
        "exitCode": exit_code,
    }


def parse_dotnet(stdout: str, stderr: str, exit_code: int) -> dict:
    text = f"{stdout}\n{stderr}"
    m = re.search(
        r"Passed:\s*(\d+).*Failed:\s*(\d+).*Skipped:\s*(\d+)",
        text,
        re.S | re.I,
    )
    if not m:
        return _empty(exit_code)
    passed, failed, skipped = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return {
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "total": passed + failed + skipped,
        "status": "Passed" if failed == 0 and exit_code == 0 else "Failed",
        "exitCode": exit_code,
    }


RUNNER_PARSERS: dict[str, Callable[[str, str, int], dict]] = {
    "pytest": parse_pytest,
    "jest": parse_jest,
    "vitest": parse_jest,
    "go": parse_go_test,
    "dotnet": parse_dotnet,
}


def parse_test_output(runner: str, stdout: str, stderr: str, exit_code: int) -> dict:
    fn = RUNNER_PARSERS.get((runner or "").lower().strip())
    if not fn:
        return _empty(exit_code)
    return fn(stdout, stderr, exit_code)
