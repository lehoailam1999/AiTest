/**
 * Disk cache for E2E route catalog — fingerprint hit avoids re-scan.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogFromCache,
  fingerprintRoutingPaths,
  loadOrBuildE2eRouteCatalog,
  serializeCatalogCache,
} from "./e2eRouteCatalogCache.js";

describe("e2eRouteCatalogCache", () => {
  it("fingerprint ignores non-routing paths", () => {
    const a = fingerprintRoutingPaths([
      "src/app/app-routing.module.ts",
      "src/app/features/evidence/list.ts",
    ]);
    const b = fingerprintRoutingPaths([
      "src/app/features/evidence/list.ts",
      "src/app/app-routing.module.ts",
      "src/other.ts",
    ]);
    assert.equal(a, b);
    assert.match(a, /app-routing/);
  });

  it("catalogFromCache misses on version bump", () => {
    const fp = fingerprintRoutingPaths(["src/app/app-routing.module.ts"]);
    const v3 = JSON.stringify({
      version: 3,
      fingerprint: fp,
      routes: ["/admin/evidence"],
      sources: ["src/app/app-routing.module.ts"],
      updatedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(catalogFromCache(v3, fp), null);
  });

  it("round-trips harvested labels and featureSources", () => {
    const fp = fingerprintRoutingPaths(["src/app/admin/evidence/evidence.routes.ts"]);
    const raw = serializeCatalogCache(
      {
        routes: ["/admin/evidence"],
        sources: ["src/app/admin/evidence/evidence.routes.ts"],
        labels: { "/admin/evidence": { vat: 8, chung: 10 } },
        featureSources: {
          "/admin/evidence": ["src/app/admin/evidence/list/evidence.component.html"],
        },
      },
      fp
    );
    const hit = catalogFromCache(raw, fp);
    assert.equal(hit?.labels?.["/admin/evidence"]?.chung, 10);
    assert.deepEqual(hit?.featureSources?.["/admin/evidence"], [
      "src/app/admin/evidence/list/evidence.component.html",
    ]);
  });

  it("catalogFromCache hits only when fingerprint matches", () => {
    const fp = fingerprintRoutingPaths(["src/app/app-routing.module.ts"]);
    const raw = serializeCatalogCache(
      { routes: ["/admin/evidence"], sources: ["src/app/app-routing.module.ts"] },
      fp
    );
    assert.ok(catalogFromCache(raw, fp)?.routes.includes("/admin/evidence"));
    assert.equal(catalogFromCache(raw, "other"), null);
  });

  it("loadOrBuildE2eRouteCatalog reuses cache then skips read of routing files", async () => {
    const routing = "src/app/app-routing.module.ts";
    let routingReads = 0;
    const files = new Map<string, string>();
    const io = {
      listSourcePaths: async () => [routing, "src/app/list.ts"],
      readText: async (pathRel: string) => {
        if (pathRel === routing) routingReads += 1;
        if (files.has(pathRel)) return files.get(pathRel)!;
        if (pathRel === routing) {
          return `{ path: '/admin/evidence', component: X }`;
        }
        throw new Error("missing");
      },
      writeText: async (pathRel: string, content: string) => {
        files.set(pathRel, content);
      },
    };

    const first = await loadOrBuildE2eRouteCatalog({ io });
    assert.equal(first.fromCache, false);
    assert.ok(first.catalog.routes.includes("/admin/evidence"));
    assert.equal(routingReads, 1);

    const second = await loadOrBuildE2eRouteCatalog({ io });
    assert.equal(second.fromCache, true);
    assert.ok(second.catalog.routes.includes("/admin/evidence"));
    assert.equal(routingReads, 1);
  });
});
