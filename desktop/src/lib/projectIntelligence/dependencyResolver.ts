import { readTextFile } from "../../tauri/bridge";
import {
  extractImportSpecifiers,
  guessPathsForSymbol,
  resolveImportToPath,
} from "./importParser";
import { buildProjectIndex } from "./projectIndex";
import type {
  ContextBuildPolicy,
  DependencyClosureItem,
  ProjectFileIndex,
} from "./types";
import { DEFAULT_CONTEXT_POLICY } from "./types";

function extCandidates(ext: string, language: string): string[] {
  const lang = language.toLowerCase();
  if (ext) return [ext];
  if (lang.includes("python")) return [".py"];
  if (lang.includes("typescript")) return [".ts", ".tsx"];
  if (lang.includes("javascript")) return [".js", ".jsx", ".ts", ".tsx"];
  if (lang.includes("c#")) return [".cs"];
  if (lang.includes("java")) return [".java"];
  if (lang.includes("go")) return [".go"];
  return [".ts", ".py", ".cs", ".java", ".go"];
}

function resolveSymbolToFile(
  symbol: string,
  index: ProjectFileIndex,
  language: string,
  fromFileRel: string
): string | null {
  const relImport = resolveImportToPath(symbol, fromFileRel, language);
  if (relImport) {
    const exts = extCandidates("", language);
    for (const e of exts) {
      const withExt = relImport.endsWith(e) ? relImport : `${relImport}${e}`;
      if (index.files.some((f) => f.pathRel === withExt)) return withExt;
      if (index.files.some((f) => f.pathRel === relImport)) return relImport;
    }
  }

  const paths = guessPathsForSymbol(symbol, index.byStem);
  if (paths.length === 1) return paths[0];
  if (paths.length > 1) {
    const dir = fromFileRel.includes("/")
      ? fromFileRel.slice(0, fromFileRel.lastIndexOf("/"))
      : "";
    const inDir = paths.find((p) => (dir ? p.startsWith(`${dir}/`) : !p.includes("/")));
    // Prefer Interfaces/ folder for I* types when several stems collide
    if (/^I[A-Z]/.test(symbol)) {
      const iface = paths.find((p) => /\/Interfaces\//i.test(p) || /Interface/i.test(p));
      if (iface) return iface;
    }
    return inDir ?? paths[0];
  }

  const stemMatch = index.byStem.get(symbol.toLowerCase());
  if (stemMatch?.length === 1) return stemMatch[0].pathRel;

  return null;
}

export async function resolveDependencyClosure(input: {
  projectRoot: string;
  seedPathRel: string;
  language: string;
  allPaths: string[];
  policy?: ContextBuildPolicy;
}): Promise<DependencyClosureItem[]> {
  const policy = input.policy ?? DEFAULT_CONTEXT_POLICY;
  const index = buildProjectIndex(input.allPaths);
  const visited = new Set<string>();
  const queue: { path: string; depth: number }[] = [{ path: input.seedPathRel, depth: 0 }];
  const closure: DependencyClosureItem[] = [];

  while (queue.length > 0 && closure.length < policy.maxDependencyFiles + 1) {
    const { path, depth } = queue.shift()!;
    const norm = path.replace(/\\/g, "/");
    if (visited.has(norm)) continue;
    visited.add(norm);

    closure.push({
      pathRel: norm,
      role: depth === 0 ? "primary" : "dependency",
      depth,
    });

    if (depth >= policy.maxDependencyDepth) continue;

    let content = "";
    try {
      content = await readTextFile(input.projectRoot, norm);
    } catch {
      continue;
    }

    const specs = extractImportSpecifiers(content, input.language, norm);
    for (const spec of specs) {
      const resolved = resolveSymbolToFile(spec, index, input.language, norm);
      if (resolved && !visited.has(resolved)) {
        queue.push({ path: resolved, depth: depth + 1 });
      }
    }
  }

  return closure;
}
