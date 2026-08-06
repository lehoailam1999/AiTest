/**
 * Batch route catalog — scan FE routing files once, match TC module/title → featurePath.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildE2eRouteCatalog,
  isRoutingFilePath,
  matchFeaturePathFromCatalog,
  MIN_MATCH_SCORE,
  STRONG_CATALOG_SCORE,
} from "./e2eRouteCatalog.js";

describe("e2eRouteCatalog", () => {
  it("detects routing file paths", () => {
    assert.equal(isRoutingFilePath("src/app/app-routing.module.ts"), true);
    assert.equal(isRoutingFilePath("src/app/features/evidence/list.component.ts"), false);
  });

  it("buildE2eRouteCatalog extracts routes from routing modules", async () => {
    const catalog = await buildE2eRouteCatalog({
      paths: [
        "src/app/app-routing.module.ts",
        "src/app/features/evidence/evidence.routes.ts",
        "src/main.ts",
      ],
      readFile: async (pathRel) => {
        if (pathRel.includes("app-routing")) {
          return `
            const routes = [
              { path: 'admin', children: [
                { path: 'evidence', component: EvidenceList },
                { path: 'rooms', component: Rooms },
              ]},
            ];
          `;
        }
        if (pathRel.includes("evidence.routes")) {
          return `{ path: '/admin/evidence/create', component: Create };`;
        }
        return "";
      },
    });
    assert.ok(catalog.routes.length >= 2);
    assert.ok(catalog.sources.some((s) => s.includes("routing")));
  });

  it("matchFeaturePathFromCatalog picks route by module/title tokens", () => {
    const catalog = {
      routes: ["/admin/evidence", "/admin/rooms", "/admin/users"],
      sources: ["mock"],
    };
    const match = matchFeaturePathFromCatalog(
      {
        title: "Create new evidence",
        module: "Evidence",
        steps: "1. Click Create",
        testData: "",
        precondition: "",
      },
      catalog
    );
    assert.equal(match.path, "/admin/evidence");
    assert.equal(match.ambiguous, false);
    assert.ok(match.score >= MIN_MATCH_SCORE);
  });

  it("does not map Vietnamese-only title via product synonyms", () => {
    const catalog = {
      routes: ["/admin/evidence", "/admin/storage-room", "/admin/users"],
      sources: ["mock"],
    };
    const match = matchFeaturePathFromCatalog(
      {
        title: "Hoàn tất tạo vật chứng",
        module: "Vật chứng",
        steps: "1. Nhấn Tạo mới",
        testData: "",
        precondition: "",
      },
      catalog
    );
    // Portable: no Forensic VI↔EN synonym table — leave path unset for FE soft-path
    assert.equal(match.path, undefined);
    assert.ok(match.score < MIN_MATCH_SCORE);
  });

  it("raises bar when FE primary already resolved", () => {
    const catalog = {
      routes: ["/admin/evidence", "/admin/rooms"],
      sources: ["mock"],
    };
    // Module-only soft hit (~2.5–3.5) must not win when FE primary present
    const weak = matchFeaturePathFromCatalog(
      {
        title: "List",
        module: "rooms",
        steps: "",
        testData: "",
        precondition: "",
      },
      catalog,
      { hasFePrimary: true }
    );
    if (weak.score > 0 && weak.score < STRONG_CATALOG_SCORE) {
      assert.equal(weak.path, undefined);
    }
    const strong = matchFeaturePathFromCatalog(
      {
        title: "Open evidence create",
        module: "Evidence",
        steps: "goto evidence create",
        testData: "pathHint: evidence",
        precondition: "",
      },
      catalog,
      { hasFePrimary: true }
    );
    assert.ok(strong.score >= STRONG_CATALOG_SCORE || strong.path === undefined);
    if (strong.score >= STRONG_CATALOG_SCORE) {
      assert.equal(strong.path, "/admin/evidence");
    }
  });
});
