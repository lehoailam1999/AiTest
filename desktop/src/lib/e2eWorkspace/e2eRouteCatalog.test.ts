/**
 * Batch route catalog — scan FE routing files once, match TC module/title → featurePath.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildE2eRouteCatalog,
  deriveRoutePrefixFromFile,
  isRoutingFilePath,
  matchFeaturePathFromCatalog,
  MIN_MATCH_SCORE,
  STRONG_CATALOG_SCORE,
} from "./e2eRouteCatalog.js";

describe("e2eRouteCatalog", () => {
  it("detects routing file paths and skips dist/specs", () => {
    assert.equal(isRoutingFilePath("src/app/app-routing.module.ts"), true);
    assert.equal(isRoutingFilePath("src/app/admin/evidence/evidence.routes.ts"), true);
    assert.equal(
      isRoutingFilePath(
        "src/Forensic/ClientApp/dist/src_app_admin_evidence_evidence_routes_ts.js"
      ),
      false
    );
    assert.equal(
      isRoutingFilePath(
        "src/app/admin/evidence/route/evidence-routing-resolve.service.ts"
      ),
      false
    );
    assert.equal(isRoutingFilePath("src/app/features/evidence/list.component.ts"), false);
  });

  it("deriveRoutePrefixFromFile composes Angular admin feature folders", () => {
    assert.equal(
      deriveRoutePrefixFromFile(
        "D:/Xlab/Forensic/forensic/src/Forensic/ClientApp/src/app/admin/evidence/evidence.routes.ts"
      ),
      "/admin/evidence"
    );
    assert.equal(
      deriveRoutePrefixFromFile("src/app/admin/admin.routes.ts"),
      "/admin"
    );
    assert.equal(
      deriveRoutePrefixFromFile(
        "src/app/entities/upload-activity/upload-activity.routes.ts"
      ),
      "/upload-activity"
    );
  });

  it("buildE2eRouteCatalog keeps /admin/evidence for modal create (skips /new AbsolutePath)", async () => {
    const catalog = await buildE2eRouteCatalog({
      paths: [
        "src/Forensic/ClientApp/dist/src_app_entities_upload-activity_upload-activity_routes_ts.js",
        "src/app/admin/admin.routes.ts",
        "src/app/admin/evidence/evidence.routes.ts",
        "src/app/admin/storage-location/storage-location.routes.ts",
        "src/app/entities/upload-activity/upload-activity.routes.ts",
        "src/app/entities/entity.routes.ts",
      ],
      readFile: async (pathRel) => {
        if (pathRel.includes("admin.routes")) {
          return `
            { path: 'evidence', loadChildren: () => import('./evidence/evidence.routes') },
            { path: 'storage-location', loadChildren: () => import('./storage-location/storage-location.routes') },
          `;
        }
        if (pathRel.includes("evidence.routes")) {
          // Forensic: create is NgbModal component — not a real browser URL for E2E
          return `
            { path: '', component: List },
            { path: 'new', loadComponent: () => import('./create/evidence-create-modal.component').then(m => m.EvidenceCreateModalComponent) },
            { path: ':id/edit', component: Edit },
          `;
        }
        if (pathRel.includes("storage-location.routes")) {
          // Full-page create (no modal in load) — /new is a real AbsolutePath
          return `
            { path: '', component: List },
            { path: 'new', loadComponent: () => import('./update/storage-location-update.component').then(m => m.X) },
          `;
        }
        if (pathRel.includes("entity.routes")) {
          return `{ path: 'upload-activity', loadChildren: () => import('./upload-activity/upload-activity.routes') }`;
        }
        if (pathRel.includes("upload-activity.routes")) {
          return `{ path: '', component: UploadActivity }`;
        }
        return "";
      },
    });
    assert.ok(catalog.routes.includes("/admin/evidence"));
    assert.ok(!catalog.routes.includes("/admin/evidence/new"));
    assert.ok(catalog.routes.includes("/admin/storage-location/new"));
    assert.ok(catalog.routes.includes("/upload-activity"));
    assert.ok(!catalog.routes.includes("/new"));
    assert.ok(
      catalog.sources.every((s) => !s.includes("/dist/")),
      "must not scan dist chunks"
    );
  });

  it("matchFeaturePathFromCatalog picks list route via requirementTitle, not upload verb", () => {
    const catalog = {
      routes: ["/admin/evidence", "/upload-activity", "/admin/rooms"],
      sources: ["mock"],
    };
    const match = matchFeaturePathFromCatalog(
      {
        title:
          "[E2E-Error] Tạo mới vật chứng - Upload hình ảnh vật chứng vượt dung lượng",
        module: "Tạo mới vật chứng",
        steps: "1. Upload oversized file",
        testData: "",
        precondition: "Đã ở bước Tài liệu liên quan",
      },
      catalog,
      { requirementTitle: "Create evidence" }
    );
    assert.equal(match.path, "/admin/evidence");
    assert.equal(match.ambiguous, false);
    assert.ok(match.score >= MIN_MATCH_SCORE);
  });

  it("module-first: ignores title Upload when module/requirement maps to evidence", () => {
    const catalog = {
      routes: ["/admin/evidence", "/upload-activity"],
      sources: ["mock"],
    };
    const match = matchFeaturePathFromCatalog(
      {
        title: "Upload activity dashboard check",
        module: "Evidence",
        steps: "1. Upload file on create modal",
        testData: "requirement: Create evidence",
        precondition: "",
      },
      catalog
    );
    assert.equal(match.path, "/admin/evidence");
  });

  it("fail-closed when module has no Latin overlap with any route", () => {
    const catalog = {
      routes: ["/admin/evidence", "/upload-activity"],
      sources: ["mock"],
    };
    const match = matchFeaturePathFromCatalog(
      {
        title: "Upload oversized image",
        module: "Tạo mới vật chứng",
        steps: "1. Upload file",
        testData: "",
        precondition: "",
      },
      catalog
    );
    assert.equal(match.path, undefined);
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
