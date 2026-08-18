/**
 * Batch route catalog — scan FE routing files once, match TC module/title → featurePath.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildE2eRouteCatalog,
  deriveRoutePrefixFromFile,
  extractUiLabelPhrases,
  featureSourcesForPath,
  isPathPlausibleForCatalog,
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

  it("extractUiLabelPhrases keeps rendered text, drops i18n keys and bindings", () => {
    const phrases = extractUiLabelPhrases(
      `<h2><span jhiTranslate="app.evidence.modal.titleAdd">Thêm vật chứng</span></h2>
       <input placeholder="Mô tả đặc điểm của vật chứng" />
       <p>{{ evidence.code }}</p>`,
      "src/app/admin/evidence/create/evidence-create-modal.component.html"
    );
    assert.ok(phrases.includes("Thêm vật chứng"));
    assert.ok(phrases.includes("Mô tả đặc điểm của vật chứng"));
    assert.ok(!phrases.some((p) => p.includes("{{")));
    assert.ok(!phrases.includes("app.evidence.modal.titleAdd"));
  });

  const labelPaths = [
    "src/app/admin/evidence/evidence.routes.ts",
    "src/app/admin/evidence/list/evidence.component.html",
    "src/app/admin/evidence/create/evidence-create-modal.component.html",
    "src/app/admin/storage-room/storage-room.routes.ts",
    "src/app/admin/storage-room/list/storage-room-list.component.html",
    "src/app/admin/person/person.routes.ts",
    "src/app/admin/person/list/person-list.component.html",
  ];

  const readLabelFixture = async (pathRel: string): Promise<string> => {
    if (pathRel.endsWith("evidence.routes.ts")) {
      return `{ path: '', component: EvidenceList }`;
    }
    if (pathRel.endsWith("storage-room.routes.ts")) {
      return `{ path: '', component: StorageRoomList }`;
    }
    if (pathRel.endsWith("person.routes.ts")) {
      return `{ path: '', component: PersonList }`;
    }
    if (pathRel.includes("/evidence/list/")) {
      return `<h1>Danh sách vật chứng</h1>
        <p>Quản lý vật chứng trong hệ thống</p>
        <th>Mã vật chứng</th><th>Loại vật chứng</th><th>Tình trạng vật chứng</th>
        <button>Thêm vật chứng</button>`;
    }
    if (pathRel.includes("/evidence/create/")) {
      return `<span>Thêm vật chứng</span>
        <span>Bước 1 - Thông tin vật chứng</span>
        <span>Bước 2 - Tài liệu liên quan</span>
        <input placeholder="Mô tả đặc điểm của vật chứng" />
        <input placeholder="Tình trạng vật lý của vật chứng" />
        <label>Vật chứng kỹ thuật số</label>
        <button>Hoàn tất quy trình</button>`;
    }
    if (pathRel.includes("/storage-room/")) {
      return `<h1>Danh sách phòng kho</h1>
        <th>Mã phòng kho</th><th>Sức chứa phòng kho</th>
        <button>Thêm phòng kho</button>`;
    }
    if (pathRel.includes("/person/")) {
      return `<h1>Danh sách nhân sự</h1>
        <th>Mã nhân sự</th><th>Chức vụ nhân sự</th>
        <button>Thêm nhân sự</button>`;
    }
    return "";
  };

  it("harvests UI labels + feature sources per route from the feature folder", async () => {
    const catalog = await buildE2eRouteCatalog({
      paths: labelPaths,
      readFile: readLabelFixture,
    });
    assert.ok(catalog.labels?.["/admin/evidence"]);
    assert.ok((catalog.labels?.["/admin/evidence"]?.["chung"] || 0) >= 3);
    // Storage-room labels must not leak into the evidence route
    assert.equal(catalog.labels?.["/admin/evidence"]?.["kho"], undefined);
    assert.deepEqual(featureSourcesForPath("/admin/evidence", catalog, 2), [
      "src/app/admin/evidence/list/evidence.component.html",
      "src/app/admin/evidence/create/evidence-create-modal.component.html",
    ]);
  });

  it("resolves a Vietnamese module through harvested labels (no synonym table)", async () => {
    const catalog = await buildE2eRouteCatalog({
      paths: labelPaths,
      readFile: readLabelFixture,
    });
    const match = matchFeaturePathFromCatalog(
      {
        title:
          "[E2E-HappyPath] Tạo mới vật chứng theo quy trình 2 bước - Hoàn tất cả hai bước",
        module: "Tạo mới vật chứng theo quy trình 2 bước",
        steps: "1. Hoàn tất Bước 1 -> mở Bước 2 Tài liệu liên quan",
        testData: "requirement: Tạo mới vật chứng theo quy trình 2 bước",
        precondition: "Người dùng đã đăng nhập; popup Tạo mới vật chứng đang mở",
      },
      catalog
    );
    assert.equal(match.path, "/admin/evidence");
    assert.equal(match.matchedBy, "label");
    assert.equal(match.ambiguous, false);
  });

  it("label fallback stays closed for a feature that does not exist in the app", async () => {
    const catalog = await buildE2eRouteCatalog({
      paths: labelPaths,
      readFile: readLabelFixture,
    });
    const match = matchFeaturePathFromCatalog(
      {
        title: "[E2E] Thanh toán hóa đơn điện tử bằng thẻ",
        module: "Thanh toán hóa đơn điện tử",
        steps: "1. Chọn phương thức thanh toán",
        testData: "requirement: Hóa đơn điện tử",
        precondition: "Đã đăng nhập",
      },
      catalog
    );
    assert.equal(match.path, undefined);
  });

  it("isPathPlausibleForCatalog rejects trace ids, accepts known areas", () => {
    const catalog = {
      routes: ["/admin/evidence", "/admin/person", "/upload-activity"],
      sources: ["mock"],
    };
    assert.equal(isPathPlausibleForCatalog("/BR-4", catalog), false);
    assert.equal(isPathPlausibleForCatalog("/billing/invoices", catalog), false);
    assert.equal(isPathPlausibleForCatalog("/admin/evidence", catalog), true);
    // Unlisted child of a known feature stays usable (manual deep links)
    assert.equal(isPathPlausibleForCatalog("/admin/evidence/42/edit", catalog), true);
    assert.equal(isPathPlausibleForCatalog("/admin/anything-else", catalog), true);
    // No catalog → cannot judge
    assert.equal(isPathPlausibleForCatalog("/BR-4", { routes: [], sources: [] }), true);
  });
});
