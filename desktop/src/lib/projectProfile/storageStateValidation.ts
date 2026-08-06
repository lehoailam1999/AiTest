/** Playwright storageState.json validation (mirror api e2e_codegen_guard). */

export function isValidStorageStateJson(content: string): boolean {
  const raw = (content || "").trim();
  if (!raw || raw === "{}") return false;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const cookies = data.cookies;
    const origins = data.origins;
    if (Array.isArray(cookies) && cookies.length > 0) return true;
    if (Array.isArray(origins) && origins.length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

/** AITest auth-seed JSON (username/password) — not Playwright cookies/origins. */
export type AuthSeedCredentials = {
  projectRel: string;
  username: string;
  password: string;
  role?: string;
};

export function parseAuthSeedCredentials(
  content: string
): Omit<AuthSeedCredentials, "projectRel"> | null {
  const raw = (content || "").trim();
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const username = String(data.username || data.user || "").trim();
    const password = String(data.password || data.pass || "").trim();
    if (!username || !password) return null;
    // Real Playwright storageState must not be treated as credential seed.
    if (isValidStorageStateJson(raw)) return null;
    const role = String(data.role || data.authRole || "").trim() || undefined;
    return { username, password, role };
  } catch {
    return null;
  }
}

export type FoundStorageState = {
  projectRel: string;
  content: string;
};

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

const COMMON_STORAGE_NAMES = [
  "storageState.json",
  "storageState-default.json",
  "storageState-admin.json",
  "storageState-user.json",
  "default.json",
  "admin.json",
  "user.json",
] as const;

/**
 * Find first valid storageState.json under profile discoverDirs (and shallow scan).
 */
export async function findValidStorageStateOnDisk(
  projectRoot: string,
  discoverDirs: string[],
  listFiles: (root: string) => Promise<string[]>,
  readOptional: (root: string, rel: string) => Promise<string | null>
): Promise<FoundStorageState | null> {
  const dirs = new Set<string>();
  for (const d of discoverDirs) {
    if (d?.trim()) dirs.add(norm(d));
  }
  dirs.add(".ai-test/auth");

  const allFiles = await listFiles(projectRoot);
  const normalized = allFiles.map(norm);

  for (const dir of dirs) {
    // Some file-list providers skip JSON; probe common storage names directly.
    for (const name of COMMON_STORAGE_NAMES) {
      const rel = `${dir}/${name}`;
      const content = await readOptional(projectRoot, rel);
      if (content && isValidStorageStateJson(content)) {
        return { projectRel: rel, content };
      }
    }
    const matches = normalized.filter(
      (f) =>
        f.startsWith(`${dir}/`) &&
        /(?:storageState[^/]*|default|admin|user)\.json$/i.test(f) &&
        !f.includes("node_modules")
    );
    for (const rel of matches.sort()) {
      const content = await readOptional(projectRoot, rel);
      if (content && isValidStorageStateJson(content)) {
        return { projectRel: rel, content };
      }
    }
  }

  const anyMatch = normalized.filter((f) =>
    /(?:storageState[^/]*|default|admin|user)\.json$/i.test(f)
  );
  for (const rel of anyMatch.sort()) {
    if (rel.includes("node_modules")) continue;
    const content = await readOptional(projectRoot, rel);
    if (content && isValidStorageStateJson(content)) {
      return { projectRel: rel, content };
    }
  }

  return null;
}

/**
 * Find AITest auth-seed credential files (username/password) under discoverDirs.
 * Used when Playwright storageState cookies are missing — UI-login fallback.
 */
export async function findAuthSeedCredentialsOnDisk(
  projectRoot: string,
  discoverDirs: string[],
  listFiles: (root: string) => Promise<string[]>,
  readOptional: (root: string, rel: string) => Promise<string | null>,
  preferredRole?: string
): Promise<AuthSeedCredentials | null> {
  const dirs = new Set<string>();
  for (const d of discoverDirs) {
    if (d?.trim()) dirs.add(norm(d));
  }
  dirs.add(".ai-test/auth");

  const prefer = (preferredRole || "default").trim().toLowerCase() || "default";
  const nameOrder = [
    `${prefer}.json`,
    "default.json",
    "admin.json",
    "user.json",
    ...COMMON_STORAGE_NAMES,
  ];
  const tried = new Set<string>();

  const tryRel = async (rel: string): Promise<AuthSeedCredentials | null> => {
    const key = norm(rel);
    if (tried.has(key)) return null;
    tried.add(key);
    const content = await readOptional(projectRoot, key);
    if (!content) return null;
    const parsed = parseAuthSeedCredentials(content);
    if (!parsed) return null;
    return { projectRel: key, ...parsed };
  };

  for (const dir of dirs) {
    for (const name of nameOrder) {
      const hit = await tryRel(`${dir}/${name}`);
      if (hit) return hit;
    }
  }

  const allFiles = (await listFiles(projectRoot)).map(norm);
  const authJson = allFiles.filter(
    (f) =>
      f.includes(".ai-test/auth/") &&
      f.endsWith(".json") &&
      !f.includes("node_modules")
  );
  for (const rel of authJson.sort()) {
    const hit = await tryRel(rel);
    if (hit) return hit;
  }
  return null;
}

/**
 * Check bundle already contains valid storageState at rel path.
 */
export function findValidStorageStateInFiles(
  files: Array<{ path: string; content?: string }>,
  preferredRels: string[]
): FoundStorageState | null {
  const byPath = new Map(files.map((f) => [norm(f.path), f]));
  for (const rel of preferredRels) {
    const f = byPath.get(norm(rel));
    if (f?.content && isValidStorageStateJson(f.content)) {
      return { projectRel: norm(rel), content: f.content };
    }
  }
  for (const f of files) {
    const p = norm(f.path);
    if (!/storageState[^/]*\.json$/i.test(p)) continue;
    if (f.content && isValidStorageStateJson(f.content)) {
      return { projectRel: p, content: f.content };
    }
  }
  return null;
}
