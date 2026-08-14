"""
Unit TC Context Builder — Minimal Sufficient Context (MSC).

Pipeline (deterministic, no LLM retrieval):
  Knowledge Map → L1 Direct → L2 Relationship → L3 Dependency
  → Rank → Token budget → MSC prompt → optional disk cache

Unit-only. E2E keeps snapshot_prompt.slice_freeze_content_for_module.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.features.requirement_studio.snapshot_prompt import (
    coerce_summary_text,
    snapshot_payload_to_prompt,
)
from app.services.unit_tc_be_context import (
    acceptance_is_ui_only,
    feature_name_only,
    filter_knowledge_primary_be,
)
from app.services.unit_tc_knowledge_map import (
    KIND_AC,
    KIND_BR,
    KIND_EXC,
    KIND_FEATURE,
    KIND_FR,
    KIND_VAL,
    PRIMARY_KINDS,
    KnowledgeMap,
    MapNode,
    build_knowledge_map,
    feature_node_for_module,
    orphan_primary_ids,
)

# Bump when Unit pack contract changes (invalidate stale MSC caches).
_MSC_PACK_CONTRACT = "be-primary-v1"

logger = logging.getLogger(__name__)

# Rank bands (higher = pack first) — PRIMARY only (no Feature L1 pack)
_RANK_L1_DIRECT = 90
_RANK_SUMMARY = 95
_RANK_L2 = 70
_RANK_L3_DEP = 55
_RANK_L3_ORPHAN = 40

# Unit MSC packs PRIMARY only (BR/VAL/ERROR/AC). Feature = name stub later.
_BUCKET_FOR_KIND: dict[str, str] = {
    KIND_BR: "businessRules",
    KIND_VAL: "validationRules",
    KIND_EXC: "exceptions",
    KIND_AC: "acceptanceCriteria",
}

_MSC_MEM: dict[str, dict[str, Any]] = {}


def unit_msc_enabled() -> bool:
    raw = (os.environ.get("AITEST_TC_UNIT_MSC") or "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def default_unit_msc_budget(*, speed_mode: str = "full") -> int:
    env = (os.environ.get("AITEST_TC_UNIT_MSC_BUDGET") or "").strip()
    if env.isdigit():
        return max(4_000, min(20_000, int(env)))
    # Dense MSC: lower ceiling than legacy 12–16k blind slice
    return 9_000 if (speed_mode or "").lower() == "full" else 7_000


def _cache_dir() -> Path:
    raw = (os.environ.get("AITEST_TC_UNIT_MSC_CACHE_DIR") or "").strip()
    if raw:
        return Path(raw)
    return Path.cwd() / ".aitest_workspace" / "unit_tc_msc_cache"


def _knowledge_fingerprint(knowledge: dict[str, Any]) -> str:
    try:
        blob = json.dumps(knowledge, ensure_ascii=False, sort_keys=True, default=str)
    except Exception:  # noqa: BLE001
        blob = str(knowledge)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:24]


def _cache_key(
    *,
    workspace_id: str,
    knowledge_version: int,
    module: str,
    soft_max: int,
    fp: str,
) -> str:
    raw = (
        f"{_MSC_PACK_CONTRACT}|{workspace_id}|v{knowledge_version}|"
        f"{module}|{soft_max}|{fp}"
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def _cache_path(key: str) -> Path:
    return _cache_dir() / f"{key}.json"


def get_msc_cache(key: str) -> str | None:
    hit = _MSC_MEM.get(key)
    if isinstance(hit, dict) and isinstance(hit.get("text"), str):
        return hit["text"]
    path = _cache_path(key)
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("text"), str):
            _MSC_MEM[key] = raw
            return raw["text"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("Unit MSC cache read failed %s: %s", path, exc)
    return None


def set_msc_cache(key: str, text: str, *, meta: dict[str, Any] | None = None) -> None:
    entry = {"text": text, **(meta or {})}
    _MSC_MEM[key] = entry
    path = _cache_path(key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Unit MSC cache write failed %s: %s", path, exc)


def clear_msc_cache_mem() -> None:
    _MSC_MEM.clear()


@dataclass(frozen=True)
class RankedNode:
    node_id: str
    rank: int
    level: str  # L1 | L2 | L3
    node: MapNode


def _module_tokens(module: str) -> list[str]:
    raw = (module or "").strip().lower()
    if not raw:
        return []
    parts = re.split(r"[\s/_\-|:,;.]+", raw)
    tokens = [p for p in parts if len(p) >= 2]
    if raw not in tokens:
        tokens.insert(0, raw)
    return tokens[:12]


def _est_chars(node: MapNode) -> int:
    return max(40, len(node.label) + len(node.text) + 24)


def _orphan_home_module(km: KnowledgeMap, node: MapNode) -> str | None:
    """Pick a single Feature name that should own an unlinked PRIMARY row."""
    features = [km.nodes[i] for i in km.by_kind.get(KIND_FEATURE, [])]
    if not features:
        return None
    blob = f"{node.label} {node.text}".lower()
    best: tuple[int, str] | None = None
    for f in features:
        tokens = _module_tokens(f.label)
        score = sum(1 for t in tokens if t in blob)
        if score <= 0:
            continue
        if best is None or score > best[0]:
            best = (score, f.label)
    if best:
        return best[1]
    # Stable parking: first feature by label
    ordered = sorted(features, key=lambda x: x.label.lower())
    return ordered[0].label if ordered else None


def retrieve_ranked_for_module(km: KnowledgeMap, module: str) -> list[RankedNode]:
    """
    3-level retrieval + orphan PRIMARY for coverage safety.
    Deterministic ranking — no LLM.
    """
    tokens = _module_tokens(module)
    feat = feature_node_for_module(km, module)
    selected: dict[str, RankedNode] = {}

    def _put(nid: str, rank: int, level: str) -> None:
        node = km.nodes.get(nid)
        if not node or node.kind == KIND_FR:
            # FR is structural; coverage via linked PRIMARY — skip virtual FR in prompt
            if node and node.kind == KIND_FR:
                return
            if not node:
                return
        prev = selected.get(nid)
        if prev is None or rank > prev.rank:
            selected[nid] = RankedNode(node_id=nid, rank=rank, level=level, node=node)

    # --- Level 1: Direct PRIMARY only (Feature is module label, not L1 pack) ---
    if feat:
        for dst, rel in km.adjacency.get(feat.node_id, []):
            if rel in {"contains", "covers", "module_of", "mentions"}:
                n = km.nodes.get(dst)
                if not n:
                    continue
                if n.kind == KIND_FR:
                    continue
                if n.kind not in PRIMARY_KINDS:
                    continue  # skip UC / actor / API / FLOWS for Unit
                if n.kind == KIND_AC and acceptance_is_ui_only(n.payload):
                    continue
                _put(dst, _RANK_L1_DIRECT, "L1")
    else:
        # No feature match — token-scan PRIMARY only
        for kind in PRIMARY_KINDS:
            for nid in km.by_kind.get(kind, []):
                n = km.nodes[nid]
                if n.kind == KIND_AC and acceptance_is_ui_only(n.payload):
                    continue
                blob = f"{n.label} {n.text}".lower()
                if tokens and any(t in blob for t in tokens):
                    _put(nid, _RANK_L1_DIRECT, "L1")

    # --- Level 2: Relationship (via FR + mentions) — PRIMARY only ---
    l1_ids = [r.node_id for r in selected.values() if r.level == "L1"]
    fr_ids: list[str] = []
    if feat:
        for dst, rel in km.adjacency.get(feat.node_id, []):
            n = km.nodes.get(dst)
            if n and n.kind == KIND_FR:
                fr_ids.append(dst)
    seeds = list(dict.fromkeys(l1_ids + fr_ids + ([feat.node_id] if feat else [])))
    for sid in seeds:
        for dst in km.neighbors(sid):
            n = km.nodes.get(dst)
            if not n or n.kind == KIND_FR:
                continue
            if n.kind not in PRIMARY_KINDS:
                continue
            if n.kind == KIND_AC and acceptance_is_ui_only(n.payload):
                continue
            if dst in selected and selected[dst].rank >= _RANK_L2:
                continue
            _put(dst, _RANK_L2, "L2")

    # --- Level 3: Dependency (depends_on from selected PRIMARY) ---
    for rid in list(selected.keys()):
        n = km.nodes.get(rid)
        if not n or n.kind not in PRIMARY_KINDS:
            continue
        for dst, rel in km.adjacency.get(rid, []):
            if rel != "depends_on":
                continue
            other = km.nodes.get(dst)
            if other and other.kind != KIND_FR:
                _put(dst, _RANK_L3_DEP, "L3")

    # --- Level 3 orphan PRIMARY: assign each orphan to exactly one home module ---
    # Avoid stuffing every orphan into every fan-out batch (legacy anti-miss bloat).
    mod_l = (module or "").strip().lower()
    for oid in orphan_primary_ids(km):
        if oid in selected:
            continue
        n = km.nodes[oid]
        if n.kind == KIND_AC and acceptance_is_ui_only(n.payload):
            continue
        home = _orphan_home_module(km, n)
        if home and home.strip().lower() == mod_l:
            _put(oid, _RANK_L3_ORPHAN + 5, "L3")
        elif not home and feat and feat.label.strip().lower() == mod_l:
            # No feature scored — park on first/exact feature batch only
            first = feature_node_for_module(km, feat.label)
            if first and first.node_id == feat.node_id:
                _put(oid, _RANK_L3_ORPHAN, "L3")

    # Never keep Feature nodes in ranked pack (name stub applied at pack time)
    drop = [nid for nid, rn in selected.items() if rn.node.kind == KIND_FEATURE]
    for nid in drop:
        selected.pop(nid, None)

    ranked = sorted(
        selected.values(),
        key=lambda r: (-r.rank, r.node.kind, r.node.label),
    )
    return ranked


def pack_knowledge_from_ranked(
    ranked: list[RankedNode],
    *,
    document_summary: str = "",
    char_budget: int,
    module: str = "",
) -> dict[str, Any]:
    """
    Pack ranked PRIMARY nodes (BR/VAL/ERROR/AC-BE) until char budget.
    FEATURES = name-only module stub. No FLOWS/useCases/actors/API.
    """
    base = len(document_summary or "") + 120
    used = base
    buckets: dict[str, list[Any]] = {k: [] for k in _BUCKET_FOR_KIND.values()}
    seen_payload: set[int] = set()

    for rn in ranked:
        bucket = _BUCKET_FOR_KIND.get(rn.node.kind)
        if not bucket:
            continue
        if rn.node.kind == KIND_AC and acceptance_is_ui_only(rn.node.payload):
            continue
        payload = rn.node.payload
        pid = id(payload) if not isinstance(payload, (str, int, float)) else hash(
            (rn.node.kind, rn.node.label, rn.node.text)
        )
        if pid in seen_payload:
            continue
        cost = _est_chars(rn.node)
        # Prefer first few PRIMARY even if tight
        force = (
            rn.rank >= _RANK_L1_DIRECT
            and sum(len(v) for v in buckets.values()) < 8
        )
        if not force and used + cost > char_budget:
            continue
        buckets[bucket].append(payload)
        seen_payload.add(pid)
        used += cost

    slim = filter_knowledge_primary_be(
        {
            "documentSummary": (document_summary or "")[:400],
            "businessRules": buckets["businessRules"],
            "validationRules": buckets["validationRules"],
            "exceptions": buckets["exceptions"],
            "acceptanceCriteria": buckets["acceptanceCriteria"],
            "features": [feature_name_only({"name": module})] if module else [],
        },
        module=module,
    )
    return slim


def build_unit_module_msc(
    *,
    title: str,
    summary: str | None,
    snap_payload: dict[str, Any] | None,
    knowledge_version: int,
    module: str,
    soft_max: int | None = None,
    workspace_id: str | None = None,
    speed_mode: str = "full",
    use_cache: bool = True,
) -> tuple[str, dict[str, Any]]:
    """
    Build Minimal Sufficient Context for one Unit TC fan-out module.

    Returns (prompt_text, meta) where meta has cacheHit, chars, ranks, …
    """
    budget = soft_max if soft_max is not None else default_unit_msc_budget(speed_mode=speed_mode)
    budget = max(4_000, min(20_000, int(budget)))
    p = snap_payload if isinstance(snap_payload, dict) else {}
    meta: dict[str, Any] = {
        "engine": "unit_msc",
        "module": module,
        "budget": budget,
        "cacheHit": False,
    }

    if p.get("schema") != "freeze-bundle-v1":
        meta["fallback"] = "not_freeze_bundle"
        return "", meta

    kw_raw = p.get("knowledge") if isinstance(p.get("knowledge"), dict) else {}
    fp = _knowledge_fingerprint(kw_raw)
    ws = str(workspace_id or "anon")
    ckey = _cache_key(
        workspace_id=ws,
        knowledge_version=int(knowledge_version or 0),
        module=module,
        soft_max=budget,
        fp=fp,
    )
    meta["cacheKey"] = ckey
    meta["knowledgeFp"] = fp

    if use_cache:
        cached = get_msc_cache(ckey)
        if cached is not None:
            meta["cacheHit"] = True
            meta["chars"] = len(cached)
            return cached, meta

    km = build_knowledge_map(kw_raw)
    ranked = retrieve_ranked_for_module(km, module)
    meta["ranked"] = len(ranked)
    meta["l1"] = sum(1 for r in ranked if r.level == "L1")
    meta["l2"] = sum(1 for r in ranked if r.level == "L2")
    meta["l3"] = sum(1 for r in ranked if r.level == "L3")

    doc_sum = coerce_summary_text(
        kw_raw.get("documentSummary") or kw_raw.get("summary") or summary or ""
    )
    # Reserve ~15% of budget for prompt wrapper / headers
    pack_budget = max(3_000, int(budget * 0.85))
    kw = pack_knowledge_from_ranked(
        ranked,
        document_summary=doc_sum,
        char_budget=pack_budget,
        module=module,
    )

    kw_summary = coerce_summary_text(p.get("knowledgeSummary") or summary)
    if len(kw_summary) > 800:
        kw_summary = kw_summary[:780] + "…"

    slim = {
        "schema": "freeze-bundle-v1",
        "knowledge": kw,
        "knowledgeSummary": kw_summary,
        "uploadedFiles": [],
        "chatTranscript": [],
        "existingTestCases": [],
    }
    text = snapshot_payload_to_prompt(
        title=f"{title} · module={module} · MSC",
        summary=kw_summary,
        payload=slim,
        knowledge_version=knowledge_version,
    )
    # Hard ceiling (ranked pack usually already under)
    if len(text) > budget:
        text = text[: budget - 20] + "\n...[truncated]"

    meta["chars"] = len(text)
    meta["packedPrimary"] = (
        len(kw.get("businessRules") or [])
        + len(kw.get("validationRules") or [])
        + len(kw.get("exceptions") or [])
        + len(kw.get("acceptanceCriteria") or [])
    )

    if use_cache:
        set_msc_cache(
            ckey,
            text,
            meta={
                "module": module,
                "knowledge_version": knowledge_version,
                "chars": len(text),
                "fp": fp,
            },
        )

    return text, meta


def slice_unit_freeze_msc(
    content: str,
    module: str,
    *,
    soft_max: int = 9_000,
    snap_payload: dict | None = None,
    title: str = "",
    summary: str | None = None,
    knowledge_version: int = 0,
    workspace_id: str | None = None,
    speed_mode: str = "full",
) -> str:
    """
    Drop-in replacement for slice_freeze_content_for_module on Unit path.
    Falls back to legacy slice when MSC cannot run.
    """
    from app.features.requirement_studio.snapshot_prompt import slice_freeze_content_for_module

    if not unit_msc_enabled():
        return slice_freeze_content_for_module(
            content,
            module,
            soft_max=soft_max,
            snap_payload=snap_payload,
            title=title,
            summary=summary,
            knowledge_version=knowledge_version,
        )

    text, meta = build_unit_module_msc(
        title=title or "Requirement Snapshot",
        summary=summary,
        snap_payload=snap_payload,
        knowledge_version=knowledge_version,
        module=module,
        soft_max=soft_max,
        workspace_id=workspace_id,
        speed_mode=speed_mode,
    )
    if text.strip():
        return text
    # Fallback preserves prior behavior
    logger.info("Unit MSC fallback → legacy slice (%s)", meta.get("fallback") or "empty")
    return slice_freeze_content_for_module(
        content,
        module,
        soft_max=soft_max,
        snap_payload=snap_payload,
        title=title,
        summary=summary,
        knowledge_version=knowledge_version,
    )
