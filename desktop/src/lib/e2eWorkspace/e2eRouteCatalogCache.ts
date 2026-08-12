/**
 * Disk-cached E2E route catalog for Approve enrich.
 * Performance: build once per batch; reuse `.ai-test/e2e-route-catalog.json` when
 * routing-file path set unchanged — never per-TC full-tree walk / Inspect.
 */
import {
  buildE2eRouteCatalog,
  isRoutingFilePath,
  type E2eRouteCatalog,
} from "./e2eRouteCatalog";
import { isUsableFeaturePath } from "./assertTcReadyForE2eGen";

export const E2E_ROUTE_CATALOG_CACHE_REL = ".ai-test/e2e-route-catalog.json";

/** Bump when extract/compose rules change so stale SUT caches rebuild. */
export const E2E_ROUTE_CATALOG_CACHE_VERSION = 3 as const;

export type E2eRouteCatalogCacheFile = {
  version: typeof E2E_ROUTE_CATALOG_CACHE_VERSION;
  /** Fingerprint of routing file path list (sorted join) */
  fingerprint: string;
  routes: string[];
  sources: string[];
  updatedAt: string;
};

export function fingerprintRoutingPaths(paths: string[]): string {
  const routing = paths
    .map((p) => p.replace(/\\/g, "/"))
    .filter(isRoutingFilePath)
    .sort((a, b) => a.localeCompare(b));
  return `${routing.length}:${routing.join("|")}`;
}

export function catalogFromCache(
  raw: string | null | undefined,
  fingerprint: string
): E2eRouteCatalog | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as E2eRouteCatalogCacheFile;
    if (parsed?.version !== E2E_ROUTE_CATALOG_CACHE_VERSION) return null;
    if (parsed.fingerprint !== fingerprint) return null;
    const routes = (parsed.routes || []).filter((r) => isUsableFeaturePath(r));
    if (!routes.length) return null;
    return {
      routes,
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    };
  } catch {
    return null;
  }
}

export function serializeCatalogCache(
  catalog: E2eRouteCatalog,
  fingerprint: string
): string {
  const payload: E2eRouteCatalogCacheFile = {
    version: E2E_ROUTE_CATALOG_CACHE_VERSION,
    fingerprint,
    routes: catalog.routes.filter((r) => isUsableFeaturePath(r)),
    sources: catalog.sources.slice(0, 80),
    updatedAt: new Date().toISOString(),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export type LoadRouteCatalogIo = {
  listSourcePaths: () => Promise<string[]>;
  readText: (pathRel: string) => Promise<string>;
  writeText?: (pathRel: string, content: string) => Promise<void>;
};

/**
 * Load cached catalog or scan routing files once (maxFiles).
 * Safe for Approve sync — no Playwright Inspect, no per-TC FE retrieve.
 */
export async function loadOrBuildE2eRouteCatalog(opts: {
  io: LoadRouteCatalogIo;
  maxFiles?: number;
  /** Pre-listed paths (skip listSourcePaths) */
  allSourcePaths?: string[] | null;
}): Promise<{
  catalog: E2eRouteCatalog;
  fromCache: boolean;
  routingFileCount: number;
}> {
  const maxFiles = opts.maxFiles ?? 40;
  const paths =
    opts.allSourcePaths && opts.allSourcePaths.length
      ? opts.allSourcePaths
      : await opts.io.listSourcePaths();
  const fingerprint = fingerprintRoutingPaths(paths);
  const routingCount = paths.filter(isRoutingFilePath).length;

  try {
    const cachedRaw = await opts.io.readText(E2E_ROUTE_CATALOG_CACHE_REL);
    const hit = catalogFromCache(cachedRaw, fingerprint);
    if (hit) {
      return { catalog: hit, fromCache: true, routingFileCount: routingCount };
    }
  } catch {
    /* cache miss */
  }

  const catalog = await buildE2eRouteCatalog({
    paths,
    readFile: opts.io.readText,
    maxFiles,
  });

  if (opts.io.writeText && catalog.routes.length) {
    try {
      await opts.io.writeText(
        E2E_ROUTE_CATALOG_CACHE_REL,
        serializeCatalogCache(catalog, fingerprint)
      );
    } catch {
      /* cache write best-effort */
    }
  }

  return { catalog, fromCache: false, routingFileCount: routingCount };
}
