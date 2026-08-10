/**
 * In-memory + localStorage persistence for project↔localPath binding.
 * Gen / Verify / Approve→MD cần path sống sót sau restart Desktop.
 */
export type RecentProject = {
  id: string;
  name: string;
  openedAt: string;
  path?: string;
};

const STORAGE_KEY = "aitest.workspace.v1";

type Persisted = {
  recent: RecentProject[];
  pathMap: Record<string, string>;
  workspaceIds: Record<string, string>;
  activeProjectId: string | null;
  favorites: string[];
};

const memory: Persisted = {
  recent: [],
  pathMap: {},
  workspaceIds: {},
  activeProjectId: null,
  favorites: [],
};

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function hydrate(): void {
  if (!canUseStorage()) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (Array.isArray(parsed.recent)) memory.recent = parsed.recent;
    if (parsed.pathMap && typeof parsed.pathMap === "object") {
      memory.pathMap = { ...parsed.pathMap };
    }
    if (parsed.workspaceIds && typeof parsed.workspaceIds === "object") {
      memory.workspaceIds = { ...parsed.workspaceIds };
    }
    if (typeof parsed.activeProjectId === "string" || parsed.activeProjectId === null) {
      memory.activeProjectId = parsed.activeProjectId ?? null;
    }
    if (Array.isArray(parsed.favorites)) memory.favorites = parsed.favorites;
    // Backfill pathMap from recent[].path
    for (const r of memory.recent) {
      if (r.path?.trim() && !memory.pathMap[r.id]) {
        memory.pathMap[r.id] = r.path.trim();
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
}

function persist(): void {
  if (!canUseStorage()) return;
  try {
    const payload: Persisted = {
      recent: memory.recent,
      pathMap: memory.pathMap,
      workspaceIds: memory.workspaceIds,
      activeProjectId: memory.activeProjectId,
      favorites: memory.favorites,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

hydrate();

export const workspace = {
  recent(): RecentProject[] {
    return [...memory.recent];
  },
  addRecent(id: string, name: string, path?: string) {
    const items = memory.recent.filter((p) => p.id !== id);
    const prev = memory.recent.find((p) => p.id === id);
    const nextPath = (path || prev?.path || "").trim() || undefined;
    items.unshift({
      id,
      name,
      path: nextPath,
      openedAt: new Date().toISOString(),
    });
    memory.recent = items.slice(0, 12);
    if (nextPath) memory.pathMap[id] = nextPath;
    persist();
  },
  getLocalPath(projectId: string): string | null {
    const fromMap = memory.pathMap[projectId]?.trim();
    if (fromMap) return fromMap;
    const fromRecent = memory.recent.find((p) => p.id === projectId)?.path?.trim();
    return fromRecent || null;
  },
  setLocalPath(projectId: string, path: string) {
    const p = path.trim();
    memory.pathMap[projectId] = p;
    const idx = memory.recent.findIndex((r) => r.id === projectId);
    if (idx >= 0) {
      memory.recent[idx] = { ...memory.recent[idx], path: p };
    }
    persist();
  },
  getWorkspaceId(projectId: string): string | null {
    return memory.workspaceIds[projectId] ?? null;
  },
  setWorkspaceId(projectId: string, workspaceId: string) {
    memory.workspaceIds[projectId] = workspaceId;
    persist();
  },
  clearWorkspaceId(projectId: string) {
    delete memory.workspaceIds[projectId];
    persist();
  },
  getActive(): string | null {
    return memory.activeProjectId;
  },
  setActive(projectId: string) {
    memory.activeProjectId = projectId;
    persist();
  },
  clearActive() {
    memory.activeProjectId = null;
    persist();
  },
  favorites(): string[] {
    return [...memory.favorites];
  },
  toggleFavorite(path: string) {
    const norm = path.replace(/\\/g, "/");
    const cur = memory.favorites;
    const next = cur.includes(norm) ? cur.filter((p) => p !== norm) : [norm, ...cur].slice(0, 20);
    memory.favorites = next;
    persist();
    return next;
  },
  isFavorite(path: string) {
    return memory.favorites.includes(path.replace(/\\/g, "/"));
  },
};
