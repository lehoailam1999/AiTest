/** Time one TC resolve stages. */
import fs from "node:fs";
import path from "node:path";
import { buildProjectIndex } from "../src/lib/projectIntelligence/projectIndex.ts";
import {
  enrichTcTestDataFromIndexAsync,
  toRepoRelativePath,
} from "../src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts";
import { parseSnapshotJson } from "../src/lib/codeIndex/indexStore.ts";

const FORENSIC = "D:/Xlab/Forensic/forensic";
const tcs = JSON.parse(
  fs.readFileSync(
    new URL("./.tmp-forensic-tcs-from-db.json", import.meta.url),
    "utf8"
  )
);
const rawTc = tcs.find((t) => /hồ sơ|ho so/i.test(t.module)) || tcs[0];

function normalizeSnap(rawSnap, projectRoot) {
  const snap = structuredClone(rawSnap);
  const files = {},
    symbolsByFile = {},
    symbolIndex = {};
  for (const [k, v] of Object.entries(snap.files || {})) {
    const rel = toRepoRelativePath(k, projectRoot) || k.replace(/\\/g, "/");
    files[rel] = { ...v, path: rel };
  }
  for (const [k, v] of Object.entries(snap.symbolsByFile || {})) {
    const rel = toRepoRelativePath(k, projectRoot) || k.replace(/\\/g, "/");
    symbolsByFile[rel] = v;
  }
  for (const [sym, paths] of Object.entries(snap.symbolIndex || {})) {
    symbolIndex[sym] = (paths || []).map(
      (p) => toRepoRelativePath(p, projectRoot) || String(p).replace(/\\/g, "/")
    );
  }
  return {
    ...snap,
    files,
    symbolsByFile,
    symbolIndex,
    importsByFile: {},
    exportsByFile: {},
    dependencyGraph: snap.dependencyGraph || {},
  };
}

let reads = 0;
const t0 = Date.now();
const mark = (s) => console.log(`${Date.now() - t0}ms ${s}`);
mark("start");
const raw = fs.readFileSync(path.join(FORENSIC, ".ai-test/index.db"), "utf8");
mark(`read db ${raw.length}`);
const codeIndex = normalizeSnap(parseSnapshotJson(raw), FORENSIC);
mark(`parse+norm files=${Object.keys(codeIndex.files).length}`);
const index = buildProjectIndex(Object.keys(codeIndex.files));
mark("projectIndex");

const tc = {
  id: rawTc.id,
  projectId: "forensic",
  testCaseId: rawTc.testCaseId,
  title: rawTc.title,
  module: rawTc.module,
  type: "Unit",
  priority: "Cao",
  severity: "Nặng",
  steps: rawTc.steps,
  expectedResult: rawTc.expectedResult,
  testData: "",
  precondition: rawTc.precondition,
  automationReady: true,
  isAiGenerated: true,
  reviewStatus: "Draft",
  executionStatus: "Pending",
  createdAt: "2026-01-01T00:00:00Z",
};
mark(`tc ${tc.testCaseId} fn=${tc.module}`);

const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
  requirementTitle: "Tạo mới vật chứng",
  projectRoot: FORENSIC,
  projectAliases: {},
  codeIndex,
  enrichProfile: { scope: "backend", sutMap: {}, domainGuards: [], intentRules: null },
  pickFromShortlist: null,
  readExcerpt: async (rel) => {
    reads++;
    try {
      return fs.readFileSync(path.join(FORENSIC, rel), "utf8");
    } catch {
      return "";
    }
  },
});
mark(`enrich done reads=${reads} enriched=${hit.enriched} skip=${(hit.skipReason || "").slice(0, 100)}`);
console.log(JSON.stringify({ path: (hit.testData || "").match(/path:\s*(.+)/)?.[1], code: (hit.testData || "").match(/code:\s*(.+)/)?.[1], skip: hit.skipReason }, null, 2));
