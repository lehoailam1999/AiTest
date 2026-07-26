/**
 * Discover the package root that owns a source file.
 * Works for any monorepo (backend/, frontend/, apps/web/, …) — not name allowlists.
 *
 * Rule: nearest package marker to the source file. Repo-root package.json (workspaces)
 * is ignored when the path heuristic already sees a nested …/src|lib package.
 */
import { readTextFile } from "../tauri/bridge";
import { packagePrefixFromSource } from "./testOutputLayout";

const PACKAGE_MARKERS = [
  "package.json",
  "nest-cli.json",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
] as const;

async function pathExists(projectRoot: string, rel: string): Promise<boolean> {
  try {
    await readTextFile(projectRoot, rel);
    return true;
  } catch {
    return false;
  }
}

function parentDir(rel: string): string {
  const p = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p.includes("/")) return "";
  return p.slice(0, p.lastIndexOf("/"));
}

function dirnameOfSource(sourceRel: string): string {
  const p = sourceRel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p.includes("/")) return "";
  return p.slice(0, p.lastIndexOf("/"));
}

async function dirHasPackageMarker(projectRoot: string, dirRel: string): Promise<boolean> {
  const base = dirRel.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const marker of PACKAGE_MARKERS) {
    const candidate = base ? `${base}/${marker}` : marker;
    if (await pathExists(projectRoot, candidate)) return true;
  }
  const folderName = base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
  if (folderName) {
    const csproj = base ? `${base}/${folderName}.csproj` : `${folderName}.csproj`;
    if (await pathExists(projectRoot, csproj)) return true;
  }
  return false;
}

/**
 * Nearest package root relative to projectRoot for the given source file.
 * Example (TestIDE-style): backend/src/todos/x.ts → "backend"
 */
export async function resolvePackagePrefix(
  projectRoot: string,
  sourceRel?: string | null
): Promise<string> {
  const src = (sourceRel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const heuristic = packagePrefixFromSource(src);
  if (!projectRoot || !src) {
    return heuristic;
  }

  let dir = dirnameOfSource(src);
  for (;;) {
    if (await dirHasPackageMarker(projectRoot, dir)) {
      // Monorepo root marker alone must not pull AItest out of backend/frontend.
      if (!dir) {
        return heuristic;
      }
      return dir;
    }
    if (!dir) break;
    dir = parentDir(dir);
  }

  return heuristic;
}
