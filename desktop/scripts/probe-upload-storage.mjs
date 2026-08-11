import fs from "fs";
import { parseSnapshotJson } from "../src/lib/codeIndex/indexStore.ts";
import { toRepoRelativePath } from "../src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts";
import { discoverFeatureFoldersFromIndex } from "@aitest/ide-protocol";

const FORENSIC = "D:/Xlab/Forensic/forensic";
const raw = fs.readFileSync(`${FORENSIC}/.ai-test/index.db`, "utf8");
const snap = parseSnapshotJson(raw);
const paths = Object.keys(snap.files || {}).map(
  (k) => toRepoRelativePath(k, FORENSIC) || k.replace(/\\/g, "/")
);
const files = Object.fromEntries(paths.map((p) => [p, {}]));
const index = { files, symbolsByFile: {}, symbolIndex: {} };
for (const [k, v] of Object.entries(snap.symbolsByFile || {})) {
  index.symbolsByFile[toRepoRelativePath(k, FORENSIC) || k.replace(/\\/g, "/")] = v;
}
for (const [sym, plist] of Object.entries(snap.symbolIndex || {})) {
  index.symbolIndex[sym] = (plist || []).map(
    (p) => toRepoRelativePath(p, FORENSIC) || String(p).replace(/\\/g, "/")
  );
}

for (const needle of ["InitUpload", "IsOccupied", "PhysicalImage", "Upload"]) {
  const hit = discoverFeatureFoldersFromIndex(index, paths, {
    titleTokens: ["Tải", "lên", "hình", "ảnh", "vật", "chứng"],
    bridgeNeedles: [needle],
  });
  console.log(needle, {
    tokens: hit.featureTokens,
    bridges: hit.bridgePaths.slice(0, 6),
  });
}
const occ = paths.filter((p) => /IsOccupied|StorageRoom|AssignEvidence|Compartment/i.test(p)).slice(0, 15);
console.log("storageish", occ);
const up = paths.filter((p) => /Upload|PhysicalImage|InitUpload/i.test(p)).slice(0, 15);
console.log("uploadish", up);
