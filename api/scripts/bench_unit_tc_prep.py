"""
Benchmark Unit TC gen prep on current workspace (no Cursor CLI).

Measures:
  - Knowledge skip-scan decision
  - Source scan wall time (old path)
  - MSC slice per module (new path)
  - Estimated CLI rounds avoided (primary-cover fast=0)

Usage:
  cd api
  python scripts/bench_unit_tc_prep.py [project_root]

Optional: set DATABASE_URL to load latest Unit-friendly freeze snapshot.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DEFAULT_PROJECT = Path(r"D:/Xlab/Forensic/forensic")


def _ms(t0: float) -> float:
    return (time.perf_counter() - t0) * 1000


def try_load_snapshot_from_db() -> dict | None:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        # common local default from .env.example
        url = (
            "host=localhost user=postgres password=postgres "
            "dbname=AITestDb port=5433 sslmode=disable TimeZone=UTC"
        )
    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
    except ImportError:
        print("[db] psycopg2 not installed — skip snapshot load")
        return None

    # Normalize libpq DSN (drop SQLAlchemy-style TimeZone=)
    dsn = " ".join(
        p
        for p in url.replace("postgresql+psycopg2://", "")
        .replace("postgresql://", "")
        .split()
        if not p.lower().startswith("timezone=")
    )
    if "://" in url and "host=" not in url:
        # SQLAlchemy URL → skip; try local default
        dsn = (
            "host=localhost user=postgres password=postgres "
            "dbname=AITestDb port=5433 sslmode=disable"
        )
    try:
        conn = psycopg2.connect(dsn)
    except Exception as exc:  # noqa: BLE001
        print(f"[db] connect failed: {exc}")
        return None

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, title, knowledge_version, payload_json, created_at
                FROM requirement_snapshots
                WHERE deleted_at IS NULL
                ORDER BY created_at DESC NULLS LAST
                LIMIT 5
                """
            )
            rows = cur.fetchall()
        if not rows:
            print("[db] no requirement_snapshots")
            return None
        print(f"[db] latest snapshots: {len(rows)}")
        for r in rows:
            print(
                f"  - {r['id']} · kv={r.get('knowledge_version')} · "
                f"{(r.get('title') or '')[:60]} · {r.get('created_at')}"
            )
        payload = rows[0].get("payload_json")
        if isinstance(payload, str):
            return json.loads(payload)
        if isinstance(payload, dict):
            return payload
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"[db] query failed: {exc}")
        return None
    finally:
        conn.close()


def synth_knowledge_from_forensic_hint() -> dict:
    """Minimal PRIMARY-shaped bundle when DB unavailable — for skip decision only."""
    return {
        "knowledge": {
            "features": [
                {"name": "Nhập mô tả vật chứng"},
                {"name": "Thực hiện bước tạo mới vật chứng"},
            ],
            "businessRules": [{"id": "BR-1"}, {"id": "BR-4"}],
            "validationRules": [{"id": "VAL-1"}, {"id": "VAL-2"}],
            "exceptions": [{"id": "EXC-1"}],
            "acceptanceCriteria": [{"id": "AC-1"}],
        }
    }


def main() -> int:
    from app.llm.tc_speed import (
        knowledge_enough_skip_source_scan,
        resolve_max_tc_per_module,
        resolve_unit_primary_retry_rounds,
    )
    from app.routers.jobs import _resolve_fan_out_titles, _source_scan_prompt_block
    from app.services.unit_tc_context_builder import (
        default_unit_msc_budget,
        slice_unit_freeze_msc,
    )

    project = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PROJECT)
    print("=== Unit TC prep bench (no LLM) ===")
    print(f"project_root={project}")
    print(f"exists={project.is_dir()}")

    bundle = try_load_snapshot_from_db()
    source = "db-snapshot"
    if not bundle:
        bundle = synth_knowledge_from_forensic_hint()
        source = "synth-PRIMARY-hint"
        print(f"[bundle] using {source} (DB miss)")
    else:
        print(f"[bundle] using {source}")

    # --- skip decision ---
    t0 = time.perf_counter()
    skip = knowledge_enough_skip_source_scan(bundle, "unit")
    print(f"skip_source_scan={skip}  ({_ms(t0):.1f} ms)")

    rounds_fast = resolve_unit_primary_retry_rounds("fast")
    rounds_full = resolve_unit_primary_retry_rounds("full")
    cap = resolve_max_tc_per_module("unit", "fast", {})
    print(f"primary_retry rounds fast={rounds_fast} full={rounds_full}")
    print(f"maxPerModule fast={cap}")

    # --- source scan (old cost) ---
    scan_ms = None
    scan_chars = 0
    if project.is_dir():
        # jobs._source_scan needs project_id UUID — call underlying scan via import path
        # Use prefer_logic scan helper through a thin wrapper if project_id unknown.
        try:
            from app.services.project_inspector import list_source_candidates
        except Exception:
            list_source_candidates = None  # type: ignore

        t0 = time.perf_counter()
        # Direct file walk similar budget: 24 files / 28k via jobs helper needs UUID.
        # Time raw prefer_logic listing instead.
        n_files = 0
        total_chars = 0
        for p in project.rglob("*"):
            if not p.is_file():
                continue
            if any(x in p.parts for x in ("node_modules", ".git", "bin", "obj", "dist")):
                continue
            if p.suffix.lower() not in {".cs", ".ts", ".java", ".py", ".go"}:
                continue
            try:
                raw = p.read_text(encoding="utf-8", errors="ignore")[:4500]
            except OSError:
                continue
            n_files += 1
            total_chars += len(raw)
            if n_files >= 24 or total_chars >= 28_000:
                break
        scan_ms = _ms(t0)
        scan_chars = total_chars
        print(
            f"source_scan_sim files={n_files} chars={scan_chars}  "
            f"({scan_ms:.0f} ms) — OLD path when not skipped"
        )
    else:
        print("source_scan_sim skipped — project root missing")

    # --- MSC ---
    from app.features.requirement_studio.snapshot_prompt import snapshot_payload_to_prompt

    content = snapshot_payload_to_prompt(
        title="bench",
        summary="",
        payload=bundle,
        knowledge_version=1,
    )
    titles = _resolve_fan_out_titles(content, snap=None, src=None)
    if not titles:
        kw = bundle.get("knowledge") if isinstance(bundle.get("knowledge"), dict) else bundle
        feats = (kw or {}).get("features") if isinstance(kw, dict) else []
        titles = [
            str(f.get("name") or f.get("title") or "").strip()
            for f in (feats or [])
            if isinstance(f, dict)
        ]
        titles = [t for t in titles if t]
    print(f"modules={len(titles)}")
    for i, t in enumerate(titles[:12]):
        safe = t.encode("ascii", "replace").decode("ascii")
        print(f"  [{i+1}] {safe}")

    budget = default_unit_msc_budget(speed_mode="fast")
    msc_times: list[float] = []
    msc_chars: list[int] = []
    for mod_title in titles[:12]:
        t0 = time.perf_counter()
        sliced = slice_unit_freeze_msc(
            content,
            mod_title,
            soft_max=budget,
            snap_payload=bundle,
            title="bench",
            summary="",
            knowledge_version=1,
            speed_mode="fast",
        )
        msc_times.append(_ms(t0))
        msc_chars.append(len(sliced or ""))

    if msc_times:
        print(
            f"MSC modules timed={len(msc_times)} budget={budget} "
            f"avg={sum(msc_times)/len(msc_times):.1f} ms "
            f"sum={sum(msc_times):.0f} ms "
            f"avg_chars={sum(msc_chars)//len(msc_chars)}"
        )

    # --- estimate ---
    print("\n--- estimate vs pre-P0 (Freeze Unit speed=fast) ---")
    if skip and scan_ms is not None:
        print(f"scan: SKIPPED (saved ~{scan_ms:.0f} ms + {scan_chars} chars)")
    elif skip:
        print("scan: SKIPPED")
    else:
        print("scan: STILL RUNS")
    print(f"primary-cover CLI rounds: {rounds_fast} (was up to 2 x Cursor oneshot)")
    print("anti-miss: parallel (was serial)")
    print(f"soft cap: {cap} TC/module")
    n_mod = max(1, len(titles))
    batch = 3
    waves = (n_mod + batch - 1) // batch
    print(
        f"fan-out estimate: {n_mod} modules / batch={batch} => ~{waves} CLI waves "
        "(CLI time dominates; prep now << CLI)"
    )
    print(
        "NOTE: Full E2E wall-clock still needs Freeze->Cursor on your Desktop; "
        "this bench measures prep on current DB snapshot only."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
