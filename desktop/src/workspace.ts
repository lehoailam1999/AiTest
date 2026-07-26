const RECENT_KEY = "aitest.recentProjects";
const PATH_MAP_KEY = "aitest.projectPaths";
const WORKSPACE_ID_KEY = "aitest.workspaceIds";
const ACTIVE_KEY = "aitest.activeProject";
const FAVORITES_KEY = "aitest.favoritePaths";

export type RecentProject = {
  id: string;
  name: string;
  openedAt: string;
  path?: string;
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const workspace = {
  recent(): RecentProject[] {
    return read<RecentProject[]>(RECENT_KEY, []);
  },
  addRecent(id: string, name: string, path?: string) {
    const items = workspace.recent().filter((p) => p.id !== id);
    items.unshift({
      id,
      name,
      path,
      openedAt: new Date().toISOString(),
    });
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, 12)));
  },
  getLocalPath(projectId: string): string | null {
    const map = read<Record<string, string>>(PATH_MAP_KEY, {});
    return map[projectId] ?? null;
  },
  setLocalPath(projectId: string, path: string) {
    const map = read<Record<string, string>>(PATH_MAP_KEY, {});
    map[projectId] = path;
    localStorage.setItem(PATH_MAP_KEY, JSON.stringify(map));
  },
  /** Backend workspace session id (after POST /workspace/open) */
  getWorkspaceId(projectId: string): string | null {
    const map = read<Record<string, string>>(WORKSPACE_ID_KEY, {});
    return map[projectId] ?? null;
  },
  setWorkspaceId(projectId: string, workspaceId: string) {
    const map = read<Record<string, string>>(WORKSPACE_ID_KEY, {});
    map[projectId] = workspaceId;
    localStorage.setItem(WORKSPACE_ID_KEY, JSON.stringify(map));
  },
  clearWorkspaceId(projectId: string) {
    const map = read<Record<string, string>>(WORKSPACE_ID_KEY, {});
    delete map[projectId];
    localStorage.setItem(WORKSPACE_ID_KEY, JSON.stringify(map));
  },
  getActive(): string | null {
    return localStorage.getItem(ACTIVE_KEY);
  },
  setActive(projectId: string) {
    localStorage.setItem(ACTIVE_KEY, projectId);
  },
  clearActive() {
    localStorage.removeItem(ACTIVE_KEY);
  },
  favorites(): string[] {
    return read<string[]>(FAVORITES_KEY, []);
  },
  toggleFavorite(path: string) {
    const norm = path.replace(/\\/g, "/");
    const cur = workspace.favorites();
    const next = cur.includes(norm) ? cur.filter((f) => f !== norm) : [norm, ...cur].slice(0, 20);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    return next;
  },
  isFavorite(path: string) {
    return workspace.favorites().includes(path.replace(/\\/g, "/"));
  },
};
