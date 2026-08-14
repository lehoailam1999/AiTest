"""
Hierarchical Knowledge Map for Unit TC Context Builder (deterministic).

Builds a graph from flat Phân tích buckets — no vector DB, no LLM.
Edges are inferred from ids, module fields, and in-text references.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# FR-01, BR-7, VAL-Ngăn, EXC-IMG, AC-02, UC-1, ERR-3
_ID_RE = re.compile(
    r"(?i)\b("
    r"FR[-_]?\d+(?:\s*[~–—-]\s*FR[-_]?\d+)?|"
    r"BR[-_]?\d+[A-Za-z0-9_-]*|"
    r"VAL[-_]?[A-Za-z0-9_-]+|"
    r"EXC[-_]?[A-Za-z0-9_-]+|"
    r"AC[-_]?\d+[A-Za-z0-9_-]*|"
    r"UC[-_]?\d+[A-Za-z0-9_-]*|"
    r"ERR[-_]?\d+[A-Za-z0-9_-]*"
    r")\b"
)

_FR_SINGLE_RE = re.compile(r"(?i)\bFR[-_]?(\d+)\b")
_FR_RANGE_RE = re.compile(
    r"(?i)\bFR[-_]?(\d+)\s*[~–—-]\s*FR[-_]?(\d+)\b"
)

KIND_FEATURE = "feature"
KIND_FR = "fr"
KIND_BR = "businessRule"
KIND_VAL = "validationRule"
KIND_EXC = "exception"
KIND_AC = "acceptance"
KIND_UC = "useCase"
KIND_ACTOR = "actor"
KIND_API = "api"
KIND_CONSTRAINT = "constraint"

PRIMARY_KINDS = frozenset({KIND_BR, KIND_VAL, KIND_EXC, KIND_AC})

_BUCKET_KIND: dict[str, str] = {
    "features": KIND_FEATURE,
    "businessRules": KIND_BR,
    "validationRules": KIND_VAL,
    "exceptions": KIND_EXC,
    "errorHandling": KIND_EXC,
    "errors": KIND_EXC,
    "acceptanceCriteria": KIND_AC,
    "useCases": KIND_UC,
    "actors": KIND_ACTOR,
    "apiSummary": KIND_API,
    "constraints": KIND_CONSTRAINT,
}


@dataclass
class MapNode:
    kind: str
    node_id: str
    label: str
    text: str
    payload: Any
    bucket_key: str = ""


@dataclass
class MapEdge:
    src: str
    dst: str
    rel: str  # contains | mentions | module_of | depends_on | covers


@dataclass
class KnowledgeMap:
    nodes: dict[str, MapNode] = field(default_factory=dict)
    edges: list[MapEdge] = field(default_factory=list)
    adjacency: dict[str, list[tuple[str, str]]] = field(default_factory=dict)
    by_kind: dict[str, list[str]] = field(default_factory=dict)
    id_index: dict[str, str] = field(default_factory=dict)  # normalized id → node_id

    def add_node(self, node: MapNode) -> None:
        self.nodes[node.node_id] = node
        self.by_kind.setdefault(node.kind, []).append(node.node_id)
        # Index only this node's own id/code — not ids merely mentioned in text
        for cand in _own_ids(node):
            self.id_index[_norm_id(cand)] = node.node_id

    def add_edge(self, src: str, dst: str, rel: str) -> None:
        if src not in self.nodes or dst not in self.nodes or src == dst:
            return
        key = (src, dst, rel)
        if any((e.src, e.dst, e.rel) == key for e in self.edges):
            return
        self.edges.append(MapEdge(src=src, dst=dst, rel=rel))
        self.adjacency.setdefault(src, []).append((dst, rel))
        self.adjacency.setdefault(dst, []).append((src, rel))

    def neighbors(self, node_id: str, *, rels: set[str] | None = None) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for dst, rel in self.adjacency.get(node_id, []):
            if rels is not None and rel not in rels:
                continue
            if dst in seen:
                continue
            seen.add(dst)
            out.append(dst)
        return out


def _as_list(v: Any) -> list[Any]:
    if v is None:
        return []
    if isinstance(v, list):
        return [x for x in v if x is not None]
    return [v]


def _norm_id(raw: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (raw or "").lower())


def _row_text(row: Any) -> str:
    if isinstance(row, str):
        return row.strip()
    if not isinstance(row, dict):
        return str(row or "").strip()
    parts: list[str] = []
    for k in (
        "id",
        "code",
        "name",
        "title",
        "text",
        "rule",
        "field",
        "description",
        "module",
        "note",
        "steps",
        "message",
    ):
        v = row.get(k)
        if v is not None and str(v).strip():
            parts.append(str(v).strip())
    return " — ".join(parts)


def _row_label(row: Any, fallback: str) -> str:
    if isinstance(row, dict):
        for k in ("id", "code", "name", "title", "field"):
            v = row.get(k)
            if v is not None and str(v).strip():
                return str(v).strip()
    if isinstance(row, str) and row.strip():
        return row.strip()[:80]
    return fallback


def _ids_from_text(text: str) -> list[str]:
    if not text:
        return []
    found: list[str] = []
    # Expand FR ranges first
    for m in _FR_RANGE_RE.finditer(text):
        a, b = int(m.group(1)), int(m.group(2))
        lo, hi = (a, b) if a <= b else (b, a)
        for n in range(lo, min(hi, lo + 40) + 1):
            found.append(f"FR-{n:02d}")
    for m in _ID_RE.finditer(text):
        tok = m.group(1).strip()
        if "~" in tok or "–" in tok or "—" in tok or re.search(r"FR.*-.*FR", tok, re.I):
            continue
        # Normalize FR-1 → FR-01
        m_fr = _FR_SINGLE_RE.fullmatch(tok) or _FR_SINGLE_RE.match(tok)
        if m_fr and re.fullmatch(r"(?i)FR[-_]?\d+", tok):
            found.append(f"FR-{int(m_fr.group(1)):02d}")
        else:
            found.append(tok.upper().replace("_", "-") if tok[:2].upper() in {"BR", "AC", "UC", "ER"} else tok)
    # de-dupe preserve order
    out: list[str] = []
    seen: set[str] = set()
    for x in found:
        k = _norm_id(x)
        if k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out


def _own_ids(node: MapNode) -> list[str]:
    """Stable identifiers owned by this node (not references in prose)."""
    ids: list[str] = []
    if isinstance(node.payload, dict):
        for k in ("id", "code"):
            v = node.payload.get(k)
            if v is not None and str(v).strip():
                ids.append(str(v).strip())
    if node.kind == KIND_FR and node.label.strip():
        ids.append(node.label.strip())
    # Feature/UC names are not FR/BR ids — skip label unless it looks like an id
    if node.kind != KIND_FEATURE:
        for cand in _ids_from_text(node.label):
            # label "BR-1: …" → own; plain prose → ignore via regex
            if _norm_id(cand):
                ids.append(cand)
    out: list[str] = []
    seen: set[str] = set()
    for x in ids:
        k = _norm_id(x)
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(x)
    return out


def _ids_from_node(node: MapNode) -> list[str]:
    ids = _own_ids(node) + _ids_from_text(node.text)
    return ids


def _module_tokens(module: str) -> list[str]:
    raw = (module or "").strip().lower()
    if not raw:
        return []
    parts = re.split(r"[\s/_\-|:,;.]+", raw)
    tokens = [p for p in parts if len(p) >= 2]
    if raw not in tokens:
        tokens.insert(0, raw)
    return tokens[:12]


def _blob(row: Any) -> str:
    if isinstance(row, dict):
        return " ".join(str(v) for v in row.values() if v is not None).lower()
    return str(row or "").lower()


def build_knowledge_map(knowledge: dict[str, Any] | None) -> KnowledgeMap:
    """Deterministic Hierarchical Map from flat Knowledge payload."""
    kw = knowledge if isinstance(knowledge, dict) else {}
    km = KnowledgeMap()

    for bucket, kind in _BUCKET_KIND.items():
        rows = _as_list(kw.get(bucket))
        for i, row in enumerate(rows):
            nid = f"{kind}:{bucket}:{i}"
            label = _row_label(row, f"{kind}-{i+1}")
            text = _row_text(row)
            km.add_node(
                MapNode(
                    kind=kind,
                    node_id=nid,
                    label=label,
                    text=text,
                    payload=row,
                    bucket_key=bucket if bucket in {
                        "features",
                        "businessRules",
                        "validationRules",
                        "exceptions",
                        "acceptanceCriteria",
                        "useCases",
                        "actors",
                        "apiSummary",
                        "constraints",
                    } else (
                        "exceptions"
                        if kind == KIND_EXC
                        else bucket
                    ),
                )
            )

    # Materialize FR nodes referenced from features / text
    fr_seeds: list[tuple[str, str]] = []  # (fr_code, parent_feature_nid)
    for fid in list(km.by_kind.get(KIND_FEATURE, [])):
        feat = km.nodes[fid]
        for code in _ids_from_text(feat.text):
            if _norm_id(code).startswith("fr"):
                fr_seeds.append((code if code.upper().startswith("FR") else f"FR-{code}", fid))

    for code, parent in fr_seeds:
        ncode = code.upper() if code.upper().startswith("FR") else code
        m = _FR_SINGLE_RE.search(ncode)
        if m:
            ncode = f"FR-{int(m.group(1)):02d}"
        key = _norm_id(ncode)
        if key in km.id_index:
            fr_nid = km.id_index[key]
        else:
            fr_nid = f"fr:virtual:{key}"
            if fr_nid not in km.nodes:
                km.add_node(
                    MapNode(
                        kind=KIND_FR,
                        node_id=fr_nid,
                        label=ncode,
                        text=ncode,
                        payload={"id": ncode},
                        bucket_key="",
                    )
                )
        km.add_edge(parent, fr_nid, "contains")

    # Mentions / depends_on from in-text ids
    for nid, node in list(km.nodes.items()):
        for ref in _ids_from_text(node.text):
            target = km.id_index.get(_norm_id(ref))
            if not target or target == nid:
                continue
            rel = "depends_on" if node.kind in PRIMARY_KINDS else "mentions"
            km.add_edge(nid, target, rel)

    # validationRules.module → feature
    for nid in km.by_kind.get(KIND_VAL, []):
        node = km.nodes[nid]
        mod = ""
        if isinstance(node.payload, dict):
            mod = str(node.payload.get("module") or "").strip()
        if not mod:
            continue
        tokens = _module_tokens(mod)
        for fid in km.by_kind.get(KIND_FEATURE, []):
            feat = km.nodes[fid]
            blob = f"{feat.label} {feat.text}".lower()
            if any(t in blob for t in tokens) or mod.lower() == feat.label.lower():
                km.add_edge(fid, nid, "module_of")

    # Soft covers: feature tokens ↔ PRIMARY / UC / API blob
    for fid in km.by_kind.get(KIND_FEATURE, []):
        feat = km.nodes[fid]
        tokens = _module_tokens(feat.label)
        if not tokens:
            continue
        for kind in (KIND_BR, KIND_VAL, KIND_EXC, KIND_AC, KIND_UC, KIND_API, KIND_ACTOR):
            for oid in km.by_kind.get(kind, []):
                other = km.nodes[oid]
                if any(t in _blob(other.payload).lower() or t in other.text.lower() for t in tokens):
                    km.add_edge(fid, oid, "covers")

    return km


def feature_node_for_module(km: KnowledgeMap, module: str) -> MapNode | None:
    """Prefer exact feature name match, else best token overlap."""
    tokens = _module_tokens(module)
    features = [km.nodes[i] for i in km.by_kind.get(KIND_FEATURE, [])]
    if not features:
        return None
    mod_l = (module or "").strip().lower()
    for f in features:
        if f.label.strip().lower() == mod_l:
            return f
    if not tokens:
        return features[0]
    scored: list[tuple[int, MapNode]] = []
    for f in features:
        blob = f"{f.label} {f.text}".lower()
        score = sum(1 for t in tokens if t in blob)
        if score:
            scored.append((score, f))
    if not scored:
        return None
    scored.sort(key=lambda x: (-x[0], x[1].label))
    return scored[0][1]


def orphan_primary_ids(km: KnowledgeMap) -> list[str]:
    """PRIMARY nodes with no edge to any feature."""
    linked: set[str] = set()
    for e in km.edges:
        for end in (e.src, e.dst):
            n = km.nodes.get(end)
            if n and n.kind == KIND_FEATURE:
                other = e.dst if end == e.src else e.src
                if km.nodes.get(other) and km.nodes[other].kind in PRIMARY_KINDS:
                    linked.add(other)
    out: list[str] = []
    for kind in PRIMARY_KINDS:
        for nid in km.by_kind.get(kind, []):
            if nid not in linked:
                out.append(nid)
    return out
