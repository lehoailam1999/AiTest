/**
 * Layer 4 — Index freshness before Approve writeBack.
 * Compare `files[path].contentHash` to hash of current disk bytes.
 * Mismatch → STALE_INDEX (caller should re-index then Re-Approve).
 *
 * Placeholder / test hashes (e.g. snapshotFromPaths `"t"`) → skipped (ok).
 * No disk content → skipped (ok) — do not block soft paths without FS reader.
 */
import { hashContent } from "../codeIndex/hashContent";
import type { CodeIndexSnapshot } from "../codeIndex/types";

export type IndexFreshnessStatus =
  | "fresh"
  | "stale"
  | "skipped"
  | "missing_file";

export type CheckIndexFileFreshnessResult = {
  ok: boolean;
  status: IndexFreshnessStatus;
  skipReason?: string;
  indexHash?: string;
  diskHash?: string;
};

/** Real hashes from incrementalSync (sha-256 hex or fnv1a64 fallback). */
export function looksLikeIndexedContentHash(hash: string): boolean {
  const h = String(hash || "").trim();
  if (!h) return false;
  if (/^[a-f0-9]{64}$/i.test(h)) return true;
  if (/^fnv1a64_[a-f0-9]+$/i.test(h)) return true;
  return false;
}

function normPath(p: string): string {
  return (p || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function resolveFileRecord(snap: CodeIndexSnapshot, pathRel: string) {
  const want = normPath(pathRel);
  if (snap.files[want]) return { pathKey: want, rec: snap.files[want]! };
  const low = want.toLowerCase();
  for (const [k, rec] of Object.entries(snap.files || {})) {
    if (normPath(k).toLowerCase() === low) return { pathKey: k, rec };
  }
  return null;
}

/**
 * @param diskContent Full file text from FS (not body-rule clip). Omit/null → skip.
 */
export async function checkIndexFileFreshness(opts: {
  codeIndex: CodeIndexSnapshot;
  pathRel: string;
  diskContent?: string | null;
}): Promise<CheckIndexFileFreshnessResult> {
  const hit = resolveFileRecord(opts.codeIndex, opts.pathRel);
  if (!hit) {
    return {
      ok: false,
      status: "missing_file",
      skipReason: "STALE_INDEX — path missing from index.db",
    };
  }

  const indexHash = String(hit.rec.contentHash || "").trim();
  if (!looksLikeIndexedContentHash(indexHash)) {
    return { ok: true, status: "skipped", indexHash };
  }

  if (opts.diskContent == null) {
    return { ok: true, status: "skipped", indexHash };
  }

  const diskHash = await hashContent(opts.diskContent);
  if (diskHash !== indexHash) {
    return {
      ok: false,
      status: "stale",
      indexHash,
      diskHash,
      skipReason:
        "STALE_INDEX — contentHash differs from disk; re-index then Re-Approve",
    };
  }

  return { ok: true, status: "fresh", indexHash, diskHash };
}
