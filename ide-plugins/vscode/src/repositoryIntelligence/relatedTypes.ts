import type { RepoDocument, RepositoryRuntime } from "./runtime";

const TEST_PATH =
  /(^|[\\/])(tests?|spec|specs|__tests__|e2e)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Types that carry the fields a test case talks about. A handler names its
 * command; the command names its DTO; the DTO holds the properties. Sibling
 * implementations of the same interface — all that `implementations` returns for
 * a handler — never contain them.
 */
const CARRIER_TYPE =
  /\b([A-Z][A-Za-z0-9_]*(?:Command|Query|Request|Dto|DTO|Model|Input|Payload|Entity|Options|Args))\b/g;

const LANGUAGE_KEYWORDS = new Set(["IRequest", "IRequestHandler", "MediatR"]);

function typeNamesIn(text: string, limit: number): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(CARRIER_TYPE)) {
    const name = match[1];
    if (!LANGUAGE_KEYWORDS.has(name)) names.add(name);
    if (names.size >= limit) break;
  }
  return [...names];
}

export type TypeExpansion = {
  paths: string[];
  searches: number;
};

/**
 * Walks type references outward from a document, two hops deep, so the property
 * shortlist can reach the DTO that actually declares the fields under test.
 */
export async function expandTypeReferences(
  seed: RepoDocument,
  runtime: RepositoryRuntime,
  options: {
    maxPaths: number;
    maxFileBytes: number;
    known: ReadonlySet<string>;
    deadlineAt?: number;
  }
): Promise<TypeExpansion> {
  const found = new Map<string, string>();
  const visited = new Set([seed.pathRel.replace(/\\/g, "/").toLowerCase()]);
  const resolvedNames = new Set<string>();
  let searches = 0;

  let frontier: RepoDocument[] = [seed];
  for (let hop = 0; hop < 2; hop++) {
    const next: RepoDocument[] = [];
    for (const doc of frontier) {
      for (const name of typeNamesIn(doc.text, 8)) {
        if (found.size >= options.maxPaths) break;
        if (options.deadlineAt && Date.now() >= options.deadlineAt) break;
        const key = name.toLowerCase();
        if (resolvedNames.has(key)) continue;
        resolvedNames.add(key);

        searches++;
        const result = await runtime.searchSymbol(name, 6);
        const hit = result.hits.find(
          (item) =>
            (item.kind === "class" || item.kind === "interface") &&
            item.name === name &&
            !TEST_PATH.test(item.pathRel)
        );
        if (!hit) continue;

        const pathKey = hit.pathRel.replace(/\\/g, "/").toLowerCase();
        if (visited.has(pathKey) || options.known.has(pathKey)) continue;
        visited.add(pathKey);
        found.set(pathKey, hit.pathRel);

        // Only the next hop needs the file body, to follow DTO chains further.
        if (hop === 0) {
          const nested = await runtime.readDocument(hit.pathRel, options.maxFileBytes);
          if (nested?.text) next.push(nested);
        }
      }
    }
    if (!next.length || found.size >= options.maxPaths) break;
    frontier = next;
  }

  return { paths: [...found.values()].slice(0, options.maxPaths), searches };
}
