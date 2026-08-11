import fs from "fs";
import { parseSnapshotJson } from "../src/lib/codeIndex/indexStore.ts";
import { toRepoRelativePath } from "../src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts";
import { buildUnitApproveQuery } from "../src/lib/unitResolve/buildUnitApproveQuery.ts";
import { resolveUnitPrimaryFromIndex } from "../src/lib/unitResolve/resolveUnitPrimaryFromIndex.ts";
import { buildProjectIndex } from "../src/lib/projectIntelligence/projectIndex.ts";

const FORENSIC = "D:/Xlab/Forensic/forensic";
const tcs = JSON.parse(
  fs.readFileSync(new URL("./.tmp-forensic-tcs-from-db.json", import.meta.url), "utf8")
);

function normalizeSnap(rawSnap, projectRoot) {
  const snap = structuredClone(rawSnap);
  const files = {}, symbolsByFile = {}, symbolIndex = {};
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
  return { ...snap, files, symbolsByFile, symbolIndex, importsByFile: {}, exportsByFile: {}, dependencyGraph: snap.dependencyGraph || {} };
}

const raw = fs.readFileSync(`${FORENSIC}/.ai-test/index.db`, "utf8");
const codeIndex = normalizeSnap(parseSnapshotJson(raw), FORENSIC);
const samples = [
  "Chọn hồ sơ vụ án",
  "người sở hữu",
  "thiết bị",
  "Tạo mới vật chứng",
  "vị trí lưu trữ",
  "hình ảnh",
].map((q) => tcs.find((t) => (t.module || "").includes(q.split(" ")[0]) || (t.module || "").includes(q)) || tcs.find((t) => (t.module || "").toLowerCase().includes(q.toLowerCase().slice(0, 6))));

const uniq = [];
for (const s of [
  tcs.find((t) => /hồ sơ|ho so/i.test(t.module)),
  tcs.find((t) => /sở hữu|so huu/i.test(t.module)),
  tcs.find((t) => /thiết bị|thiet bi/i.test(t.module)),
  tcs.find((t) => /^Tạo mới vật chứng$/i.test(t.module)),
  tcs.find((t) => /vị trí|vi tri/i.test(t.module)),
  tcs.find((t) => /hình ảnh|hinh anh/i.test(t.module)),
]) {
  if (s && !uniq.find((u) => u.testCaseId === s.testCaseId)) uniq.push(s);
}

for (const rawTc of uniq) {
  const tc = {
    title: rawTc.title,
    module: rawTc.module,
    steps: rawTc.steps,
    expectedResult: rawTc.expectedResult,
    testData: "",
    precondition: rawTc.precondition || "",
  };
  const query = buildUnitApproveQuery(tc, { requirementTitle: "Tạo mới vật chứng" });
  const t0 = Date.now();
  const r = await resolveUnitPrimaryFromIndex({
    codeIndex,
    query,
    readExcerpt: null,
    topK: 16,
    fallbackPaths: Object.keys(codeIndex.files),
    pickFromShortlist: null,
  });
  console.log(
    JSON.stringify({
      tc: rawTc.testCaseId,
      fn: rawTc.module,
      ms: Date.now() - t0,
      write: r.writeBack,
      path: r.seed?.pathRel,
      code: r.symbol,
      skip: (r.skipReason || "").slice(0, 100),
      notes: (r.notes || []).slice(0, 6),
    })
  );
}
