/**
 * Fast Approve resolve eval on DB Unit TCs (no LLM).
 * Passes enrichProfile inline to skip disk profile load.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProjectIndex } from "../src/lib/projectIntelligence/projectIndex.ts";
import {
  enrichTcTestDataFromIndexAsync,
  toRepoRelativePath,
} from "../src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts";
import { parseSnapshotJson } from "../src/lib/codeIndex/indexStore.ts";

const FORENSIC = "D:/Xlab/Forensic/forensic";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const TCS = path.join(DIR, ".tmp-forensic-tcs-from-db.json");
const OUT = path.join(DIR, ".tmp-forensic-resolve-eval.json");
const MODULE_DOC = process.env.AITEST_MODULE || "Tạo mới vật chứng";
const LIMIT = Number(process.env.AITEST_LIMIT || 0) || 0;
const CONCURRENCY = Number(process.env.AITEST_CONC || 6);

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

function expectFamily(tc) {
  const blob = [MODULE_DOC, tc.module, tc.title, tc.steps]
    .join("\n")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/nguoi\s*(so\s*huu|su\s*dung|lien\s*quan)/.test(blob)) return "CasePerson";
  if (/hinh\s*anh|tai\s*len.*anh|anh\s*vat|xoa\s*hinh/.test(blob))
    return "PhysicalImage|DigitalFile|Upload";
  if (/tep\s*ky\s*thuat|tai\s*len\s*tep/.test(blob)) return "DigitalFile|Upload";
  if (/thiet\s*bi|imei/.test(blob) && !/khong\s*phai\s*ky\s*thuat/.test(blob))
    return "DigitalDevice";
  if (/vi\s*tri|luu\s*tru|phong\s*luu|tu\s*luu|ngan/.test(blob))
    return "StorageRoom|AssignEvidence|EvidenceAssign";
  if (/gan\s*ho\s*so|ho\s*so\s*vu\s*an|chon\s*ho\s*so/.test(blob))
    return "EvidenceAssignCase|AssignCase|Case";
  if (/phan\s*loai/.test(blob)) return "Evidence|Classification";
  if (/hoan\s*tat|quy\s*trinh/.test(blob)) return "EvidenceCreate|Evidence";
  if (/mo\s*ta.*khong\s*phai|khong\s*phai\s*ky\s*thuat/.test(blob))
    return "EvidenceCreate|EvidenceUpdate";
  if (/tao\s*moi\s*vat|nhap\s*ma|ten\s*vat|buoc\s*tao/.test(blob))
    return "EvidenceCreate";
  return "Evidence";
}

function familyHit(pathRel, expect) {
  if (!pathRel) return false;
  const p = pathRel.replace(/\\/g, "/");
  return expect.split("|").some((a) => new RegExp(a.replace(/\*$/, ""), "i").test(p));
}

function line(td, re) {
  return (td || "").split(/\r?\n/).find((l) => re.test(l)) || "";
}

const t0 = Date.now();
process.stderr.write("load index…\n");
const raw = fs.readFileSync(path.join(FORENSIC, ".ai-test/index.db"), "utf8");
const codeIndex = normalizeSnap(parseSnapshotJson(raw), FORENSIC);
const index = buildProjectIndex(Object.keys(codeIndex.files));
process.stderr.write(
  `index files=${Object.keys(codeIndex.files).length} in ${Date.now() - t0}ms\n`
);

let tcs = JSON.parse(fs.readFileSync(TCS, "utf8"));
if (LIMIT > 0) tcs = tcs.slice(0, LIMIT);

const excerptCache = new Map();
async function readExcerpt(rel) {
  if (excerptCache.has(rel)) return excerptCache.get(rel);
  let text = "";
  try {
    text = fs.readFileSync(path.join(FORENSIC, rel), "utf8");
  } catch {
    text = "";
  }
  excerptCache.set(rel, text);
  return text;
}

const enrichProfile = {
  scope: "backend",
  sutMap: {},
  domainGuards: [],
  intentRules: null,
};

async function evalOne(rawTc) {
  const tc = {
    id: rawTc.id,
    projectId: "forensic",
    testCaseId: rawTc.testCaseId,
    title: rawTc.title,
    module: rawTc.module,
    type: "Unit",
    priority: rawTc.priority || "Cao",
    severity: rawTc.severity || "Nặng",
    steps: rawTc.steps,
    expectedResult: rawTc.expectedResult,
    testData: String(rawTc.testData || "")
      .replace(/path:\s*.+$/gim, "")
      .replace(/code:\s*.+$/gim, "")
      .replace(/related:\s*.+$/gim, "")
      .replace(/#\s*auto-enriched[\s\S]*/i, "")
      .replace(/#\s*sut-resolve:[\s\S]*/i, "")
      .trim(),
    precondition: rawTc.precondition,
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: rawTc.reviewStatus || "Draft",
    executionStatus: "Pending",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
    requirementTitle: MODULE_DOC,
    projectRoot: FORENSIC,
    projectAliases: {},
    codeIndex,
    enrichProfile,
    pickFromShortlist: null,
    readExcerpt,
  });
  const pathRel = line(hit.testData, /^\s*path\s*:/i)
    .replace(/^\s*path\s*:\s*/i, "")
    .trim();
  const code = line(hit.testData, /^\s*code\s*:/i)
    .replace(/^\s*code\s*:\s*/i, "")
    .trim();
  const expect = expectFamily(tc);
  const okFamily = hit.enriched && familyHit(pathRel, expect);
  return {
    tc: tc.testCaseId,
    function: tc.module,
    title: (tc.title || "").slice(0, 90),
    expect,
    enriched: hit.enriched,
    skipReason: (hit.skipReason || "").slice(0, 160),
    path: pathRel,
    code,
    verdict: !hit.enriched ? "SKIP" : okFamily ? "OK" : "WRONG",
  };
}

const rows = [];
for (let i = 0; i < tcs.length; i += CONCURRENCY) {
  const batch = tcs.slice(i, i + CONCURRENCY);
  const tBatch = Date.now();
  const part = await Promise.all(batch.map(evalOne));
  rows.push(...part);
  process.stderr.write(
    `… ${rows.length}/${tcs.length} (+${Date.now() - tBatch}ms)\n`
  );
}

const summary = {
  total: rows.length,
  ok: rows.filter((r) => r.verdict === "OK").length,
  wrong: rows.filter((r) => r.verdict === "WRONG").length,
  skip: rows.filter((r) => r.verdict === "SKIP").length,
  skipBuckets: {},
  byFunction: {},
  ms: Date.now() - t0,
};
for (const r of rows.filter((x) => x.verdict === "SKIP")) {
  let k = "other";
  const s = r.skipReason || "";
  if (/moduleGate miss/i.test(s)) k = "moduleGate miss";
  else if (/FAIL_UNGATED/i.test(s)) k = "FAIL_UNGATED";
  else if (/ambiguous/i.test(s)) k = "ambiguous";
  else if (/FEATURE_GAP|ui_master/i.test(s)) k = "FEATURE_GAP";
  else if (/body-rule/i.test(s)) k = "body-rule";
  else if (/SOFT_NO_DOMAIN/i.test(s)) k = "SOFT_NO_DOMAIN";
  else if (/SOFT_CROSS/i.test(s)) k = "SOFT_CROSS";
  summary.skipBuckets[k] = (summary.skipBuckets[k] || 0) + 1;
}
for (const r of rows) {
  const fn = r.function || "?";
  if (!summary.byFunction[fn]) summary.byFunction[fn] = { ok: 0, wrong: 0, skip: 0 };
  summary.byFunction[fn][r.verdict.toLowerCase()]++;
}

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      summary,
      wrong: rows.filter((r) => r.verdict === "WRONG"),
      skip: rows.filter((r) => r.verdict === "SKIP"),
      ok: rows.filter((r) => r.verdict === "OK"),
    },
    null,
    2
  ),
  "utf8"
);

const brief = {
  module: MODULE_DOC,
  ...summary,
  wrongList: rows
    .filter((r) => r.verdict === "WRONG")
    .map((r) => ({ tc: r.tc, expect: r.expect, code: r.code, path: r.path, fn: r.function })),
  skipTop: rows
    .filter((r) => r.verdict === "SKIP")
    .slice(0, 25)
    .map((r) => ({ tc: r.tc, skip: r.skipReason, fn: r.function })),
  out: OUT,
};
fs.writeFileSync(path.join(DIR, ".tmp-eval-brief.json"), JSON.stringify(brief, null, 2));
process.stdout.write(JSON.stringify(brief, null, 2) + "\n");
