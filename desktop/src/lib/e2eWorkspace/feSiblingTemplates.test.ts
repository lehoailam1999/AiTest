import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachSiblingFeTemplates,
  hasFeGroundingHooks,
  siblingTemplatePaths,
  toFeReadPath,
} from "./resolveE2eFeSources.js";

describe("siblingTemplatePaths", () => {
  it("maps Angular .component.ts → .component.html", () => {
    assert.deepEqual(
      siblingTemplatePaths("src/app/admin/x/list/x.component.ts"),
      ["src/app/admin/x/list/x.component.html"]
    );
  });
});

describe("toFeReadPath", () => {
  it("strips projectRoot prefix from absolute paths", () => {
    assert.equal(
      toFeReadPath("D:/Xlab/Forensic", "D:/Xlab/Forensic/src/app/a.component.html"),
      "src/app/a.component.html"
    );
  });
});

describe("attachSiblingFeTemplates", () => {
  it("loads sibling HTML so FE hooks (data-cy) become visible", async () => {
    const ts = "export class StorageLocationComponent {}\n";
    const html = `
      <h2 data-cy="StorageLocationHeading">Locations</h2>
      <button data-cy="entityCreateButton" [routerLink]="['/admin/storage-location/new']">New</button>
    `;
    const files: Record<string, string> = {
      "src/app/admin/storage-location/list/storage-location.component.ts": ts,
      "src/app/admin/storage-location/list/storage-location.component.html": html,
    };
    const withTpl = await attachSiblingFeTemplates({
      projectRoot: "D:/fake",
      sourceFileName: "src/app/admin/storage-location/list/storage-location.component.ts",
      relatedSources: [],
      readFile: async (_root, pathRel) => {
        const key = pathRel.replace(/\\/g, "/");
        if (!(key in files)) throw new Error(`missing ${key}`);
        return files[key];
      },
    });
    assert.match(withTpl.notes.join("\n"), /FE template sibling=/);
    assert.equal(withTpl.relatedSources.length, 1);
    assert.equal(hasFeGroundingHooks(ts, []), false);
    assert.equal(hasFeGroundingHooks(ts, withTpl.relatedSources), true);
    assert.match(withTpl.relatedSources[0].content, /data-cy="StorageLocationHeading"/);
  });

  it("pulls create modal when primary is list + create actionHint", async () => {
    const listHtml = `<h2 data-cy="EvidenceHeading">List</h2>`;
    const createHtml = `<stitch-select id="field_caseRecords" formControlName="caseRecords"></stitch-select>`;
    const files: Record<string, string> = {
      "src/app/admin/evidence/list/evidence.component.html": listHtml,
      "src/app/admin/evidence/create/evidence-create-modal.component.html": createHtml,
    };
    const withTpl = await attachSiblingFeTemplates({
      projectRoot: "D:/fake",
      sourceFileName: "src/app/admin/evidence/list/evidence.component.html",
      relatedSources: [],
      actionHint: "Tạo mới vật chứng - Chọn nhiều hồ sơ",
      readFile: async (_root, pathRel) => {
        const key = pathRel.replace(/\\/g, "/");
        if (!(key in files)) throw new Error(`missing ${key}`);
        return files[key];
      },
    });
    assert.match(withTpl.notes.join("\n"), /FE form surface=/);
    assert.ok(
      withTpl.relatedSources.some((r) =>
        /field_caseRecords/.test(r.content)
      )
    );
  });
});
