/**
 * Map TestCase → Requirement title.
 * SoT: requirement-workspaces (Studio) via requirementSnapshotId,
 * plus legacy /requirements via sourceId.
 */
import { requirementStudio, requirements } from "../../api";
import type { TestCase } from "../../api/types";

function stamp(
  out: Record<string, string>,
  tc: TestCase,
  title: string
): void {
  const t = title.trim();
  if (!t) return;
  out[tc.id] = t;
  if (tc.testCaseId) out[tc.testCaseId] = t;
  if (tc.sourceId) out[tc.sourceId] = t;
  if (tc.requirementSnapshotId) out[tc.requirementSnapshotId] = t;
}

/** Legacy Requirements table: sourceId === requirement.id */
async function titlesFromLegacyRequirements(
  projectId: string
): Promise<Map<string, string>> {
  const byId = new Map<string, string>();
  let page = 1;
  for (;;) {
    const res = await requirements.list(projectId, page, 100);
    for (const r of res.items || []) {
      const title = (r.title || "").trim();
      if (title) byId.set(r.id, title);
    }
    const total = res.total ?? byId.size;
    if (!res.items?.length || byId.size >= total || page >= 50) break;
    page += 1;
  }
  return byId;
}

/**
 * Studio: snapshotId → workspace.title (fallback snapshot.title).
 * Also map legacySourceId on workspace when present.
 */
async function titlesFromRequirementWorkspaces(
  projectId: string,
  snapshotIds: string[]
): Promise<{
  bySnapshotId: Map<string, string>;
  byLegacySourceId: Map<string, string>;
}> {
  const bySnapshotId = new Map<string, string>();
  const byLegacySourceId = new Map<string, string>();
  if (!projectId) return { bySnapshotId, byLegacySourceId };

  const need = new Set(snapshotIds.filter(Boolean));
  try {
    const wsRes = await requirementStudio.listWorkspaces(projectId);
    const workspaces = wsRes.items || [];
    for (const ws of workspaces) {
      const wsTitle = (ws.title || "").trim();
      if (ws.legacySourceId && wsTitle) {
        byLegacySourceId.set(String(ws.legacySourceId), wsTitle);
      }
      // Always load snapshots for title map (small N per project)
      try {
        const snaps = await requirementStudio.listSnapshots(ws.id);
        for (const s of snaps.items || []) {
          const title = wsTitle || (s.title || "").trim();
          if (!title) continue;
          bySnapshotId.set(s.id, title);
          // If caller only asked for some ids, still fill all — cheap & cacheable next sync
        }
      } catch {
        /* workspace may have no snapshots */
      }
    }

    // Fill any missing snapshot via getSnapshot (edge: workspace list incomplete)
    for (const sid of need) {
      if (bySnapshotId.has(sid)) continue;
      try {
        const snap = await requirementStudio.getSnapshot(sid);
        const ws = await requirementStudio.getWorkspace(snap.workspaceId);
        const title = (ws.title || snap.title || "").trim();
        if (title) bySnapshotId.set(sid, title);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* studio API unavailable — legacy only */
  }
  return { bySnapshotId, byLegacySourceId };
}

/**
 * Build id / testCaseId / sourceId / snapshotId → Requirement title.
 */
export async function buildRequirementTitleByCaseKey(
  projectId: string,
  cases: TestCase[]
): Promise<Record<string, string>> {
  if (!projectId || !cases.length) return {};
  const out: Record<string, string> = {};
  try {
    const snapshotIds = [
      ...new Set(
        cases
          .map((c) => (c.requirementSnapshotId || "").trim())
          .filter(Boolean)
      ),
    ];
    const [{ bySnapshotId, byLegacySourceId }, legacyById] = await Promise.all([
      titlesFromRequirementWorkspaces(projectId, snapshotIds),
      titlesFromLegacyRequirements(projectId).catch(
        () => new Map<string, string>()
      ),
    ]);

    for (const tc of cases) {
      const snapId = (tc.requirementSnapshotId || "").trim();
      const sid = (tc.sourceId || "").trim();
      const title =
        (snapId && bySnapshotId.get(snapId)) ||
        (sid && byLegacySourceId.get(sid)) ||
        (sid && legacyById.get(sid)) ||
        "";
      if (title) stamp(out, tc, title);
    }
    return out;
  } catch {
    return out;
  }
}
