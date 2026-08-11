import fs from "fs";
import { parseSnapshotJson } from "../src/lib/codeIndex/indexStore.ts";
import {
  discoverFeatureFoldersFromIndex,
  bridgeNeedlesForDiscover,
  extractUnitIntent,
} from "@aitest/ide-protocol";
import { toRepoRelativePath } from "../src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts";
import { buildUnitApproveQuery } from "../src/lib/unitResolve/buildUnitApproveQuery.ts";

const FORENSIC = "D:/Xlab/Forensic/forensic";
const raw = fs.readFileSync(`${FORENSIC}/.ai-test/index.db`, "utf8");
const snap = parseSnapshotJson(raw);
const paths = Object.keys(snap.files || {}).map(
  (k) => toRepoRelativePath(k, FORENSIC) || k.replace(/\\/g, "/")
);
const files = Object.fromEntries(paths.map((p) => [p, {}]));
const index = { files, symbolsByFile: {}, symbolIndex: {} };
for (const [k, v] of Object.entries(snap.symbolsByFile || {})) {
  const rel = toRepoRelativePath(k, FORENSIC) || k.replace(/\\/g, "/");
  index.symbolsByFile[rel] = v;
}
for (const [sym, plist] of Object.entries(snap.symbolIndex || {})) {
  index.symbolIndex[sym] = (plist || []).map(
    (p) => toRepoRelativePath(p, FORENSIC) || String(p).replace(/\\/g, "/")
  );
}

const tc = {
  title: "Chọn hồ sơ vụ án cho vật chứng - Lọc theo quyền",
  module: "Chọn hồ sơ vụ án cho vật chứng",
  steps: "lọc",
  expectedResult: "vụ án",
  testData: "",
  precondition: "",
};
const q = buildUnitApproveQuery(tc, { requirementTitle: "Tạo mới vật chứng" });
console.log("query", {
  primary: q.intent.primaryClass,
  classes: q.intent.classes,
  codeFieldCreate: q.codeFieldCreate,
  blob: q.tcBlob,
  rules: (q.intent.rulePatterns || []).slice(0, 6),
});
const titleTokens = ["Chọn", "hồ", "sơ", "vụ", "án", "vật", "chứng"];
console.log("needles", bridgeNeedlesForDiscover(q.intent, titleTokens));
for (const needles of [[], ["Assign"], ["AssignCase"], ["Case"], ["CheckCode"]]) {
  const hit = discoverFeatureFoldersFromIndex(index, paths, {
    intent: q.intent,
    titleTokens,
    bridgeNeedles: needles,
  });
  console.log(JSON.stringify({ needles, tokens: hit.featureTokens, bridges: hit.bridgePaths.slice(0, 6) }));
}

// CheckCode folders on index
const cc = paths.filter((p) => /CheckCode/i.test(p)).slice(0, 10);
console.log("checkCode sample", cc);
