/**
 * Index-backed + unified code token expansion (portable).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  expandCodeMatchTokens,
  expandVietnameseToCodeTokens,
} from "./viCodeAliases.js";
import {
  expandTokensFromIndex,
  extractStemsFromIndexPaths,
  filterTokensHittingPaths,
} from "./expandTokensFromIndex.js";

describe("expandTokensFromIndex", () => {
  const paths = [
    "src/App/Commands/Evidence/EvidencePhysicalImageCreateCommandHandler.cs",
    "src/App/Commands/Evidence/EvidenceDocumentCreateCommandHandler.cs",
    "src/App/Blob/NhanTapTinService.cs",
  ];

  it("extracts Pascal stems from handler paths", () => {
    const stems = extractStemsFromIndexPaths(paths);
    assert.ok(stems.includes("Evidence"));
    assert.ok(stems.includes("Physical"));
    assert.ok(stems.includes("Image"));
    assert.ok(stems.some((s) => /NhanTapTin/i.test(s)));
  });

  it("matches Latin identifiers in TC text to index stems", () => {
    const tokens = expandTokensFromIndex(
      "UploadEvidenceImageCommand invalid png",
      paths
    );
    assert.ok(tokens.some((t) => /Evidence|PhysicalImage|Image/i.test(t)));
  });

  it("returns empty when no index paths", () => {
    assert.deepEqual(expandTokensFromIndex("tai len hinh anh", []), []);
  });
});

describe("expandCodeMatchTokens", () => {
  const paths = [
    "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
    "src/App/Commands/Order/OrderCreateCommandHandler.cs",
  ];

  it("filters bootstrap Upload token when index has no Upload paths", () => {
    const raw = "tai len widget";
    const withIndex = expandCodeMatchTokens(raw, {
      projectAliases: { widget: ["Widget"] },
      indexPaths: paths,
    });
    assert.ok(withIndex.some((t) => /Widget/i.test(t)));
    assert.ok(!withIndex.some((t) => /^Upload$/i.test(t)));
  });

  it("without indexPaths keeps bootstrap IT expansion", () => {
    const out = expandVietnameseToCodeTokens("tai len file");
    assert.ok(out.includes("Upload"));
  });

  it("filterTokensHittingPaths drops non-hit bootstrap tokens", () => {
    const filtered = filterTokensHittingPaths(
      ["Upload", "Widget", "Create"],
      paths
    );
    assert.ok(filtered.includes("Widget"));
    assert.ok(filtered.includes("Create"));
    assert.ok(!filtered.includes("Upload"));
  });
});
