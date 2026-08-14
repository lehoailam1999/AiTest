import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashContent } from "../codeIndex/hashContent.js";
import { snapshotFromPaths } from "./snapshotFromPaths.js";
import {
  checkIndexFileFreshness,
  looksLikeIndexedContentHash,
} from "./checkIndexFileFreshness.js";

describe("checkIndexFileFreshness (Layer 4)", () => {
  it("looksLikeIndexedContentHash accepts sha256 / fnv only", () => {
    assert.equal(looksLikeIndexedContentHash("t"), false);
    assert.equal(looksLikeIndexedContentHash("abc"), false);
    assert.equal(
      looksLikeIndexedContentHash("a".repeat(64)),
      true
    );
    assert.equal(looksLikeIndexedContentHash("fnv1a64_deadbeef"), true);
  });

  it("skips when index hash is placeholder (test snapshot)", async () => {
    const pathRel = "src/App/WidgetCreateCommandHandler.cs";
    const snap = snapshotFromPaths([pathRel]);
    const r = await checkIndexFileFreshness({
      codeIndex: snap,
      pathRel,
      diskContent: "class WidgetCreateCommandHandler {}",
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, "skipped");
  });

  it("fresh when disk hash matches index", async () => {
    const pathRel = "src/App/WidgetCreateCommandHandler.cs";
    const body = "public class WidgetCreateCommandHandler { }";
    const dig = await hashContent(body);
    const snap = snapshotFromPaths([pathRel]);
    snap.files[pathRel]!.contentHash = dig;
    const r = await checkIndexFileFreshness({
      codeIndex: snap,
      pathRel,
      diskContent: body,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.status, "fresh");
    assert.equal(r.diskHash, dig);
  });

  it("STALE_INDEX when disk differs", async () => {
    const pathRel = "src/App/WidgetCreateCommandHandler.cs";
    const indexed = "public class WidgetCreateCommandHandler { void A(){} }";
    const dig = await hashContent(indexed);
    const snap = snapshotFromPaths([pathRel]);
    snap.files[pathRel]!.contentHash = dig;
    const r = await checkIndexFileFreshness({
      codeIndex: snap,
      pathRel,
      diskContent: "public class WidgetCreateCommandHandler { void B(){} }",
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, "stale");
    assert.match(r.skipReason || "", /STALE_INDEX/);
  });

  it("skips when no disk content", async () => {
    const pathRel = "src/App/WidgetCreateCommandHandler.cs";
    const dig = await hashContent("x");
    const snap = snapshotFromPaths([pathRel]);
    snap.files[pathRel]!.contentHash = dig;
    const r = await checkIndexFileFreshness({
      codeIndex: snap,
      pathRel,
      diskContent: null,
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, "skipped");
  });
});
