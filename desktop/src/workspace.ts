export type RecentProject = {
  id: string;
  name: string;
  openedAt: string;
  path?: string;
};

const memory = {
  recent: [] as RecentProject[],
  pathMap: {} as Record<string, string>,
  workspaceIds: {} as Record<string, string>,
  activeProjectId: null as string | null,
  favorites: [] as string[],
};

export const workspace = {
  recent(): RecentProject[] {
    return [...memory.recent];
  },
  addRecent(id: string, name: string, path?: string) {
    const items = memory.recent.filter((p) => p.id !== id);
    items.unshift({
      id,
      name,
      path,
      openedAt: new Date().toISOString(),
    });
    memory.recent = items.slice(0, 12);
  },
  getLocalPath(projectId: string): string | null {
    return memory.pathMap[projectId] ?? null;
  },
  setLocalPath(projectId: string, path: string) {
    memory.pathMap[projectId] = path;
  },
  /** Backend workspace session id (after POST /workspace/open) */
  getWorkspaceId(projectId: string): string | null {
    return memory.workspaceIds[projectId] ?? null;
  },
  setWorkspaceId(projectId: string, workspaceId: string) {
    memory.workspaceIds[projectId] = workspaceId;
  },
  clearWorkspaceId(projectId: string) {
    delete memory.workspaceIds[projectId];
  },
  getActive(): string | null {
    return memory.activeProjectId;
  },
  setActive(projectId: string) {
    memory.activeProjectId = projectId;
  },
  clearActive() {
    memory.activeProjectId = null;
  },
  favorites(): string[] {
    return [...memory.favorites];
  },
  toggleFavorite(path: string) {
    const norm = path.replace(/\\/g, "/");
    const cur = memory.favorites;
    const next = cur.includes(norm) ? cur.filter((f) => f !== norm) : [norm, ...cur].slice(0, 20);
    memory.favorites = next;
    return next;
  },
  isFavorite(path: string) {
    return memory.favorites.includes(path.replace(/\\/g, "/"));
  },
};
