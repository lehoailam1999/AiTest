import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildE2eRouteCatalog,
  isRoutingFilePath,
  matchFeaturePathFromCatalog,
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
        title: "Tạo vật chứng mới",
        module: "Evidence",
        steps: "1. Nhấn Tạo mới",
        testData: "",
        precondition: "",
      },
      catalog
    );
    assert.equal(match.path, "/admin/evidence");
    assert.equal(match.ambiguous, false);
    assert.ok(match.score >= 1.5);
  });

  it("matchFeaturePathFromCatalog maps Vietnamese vật chứng to evidence", () => {
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
    assert.equal(match.path, "/admin/evidence");
  });
});
