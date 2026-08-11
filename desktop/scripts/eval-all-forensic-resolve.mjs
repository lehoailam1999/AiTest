/**
 * Re-run Approve resolve on all Forensic .ai-test/test-cases MD files.
 * Uses live index.db + excerpts; no LLM mock (deterministic only).
 * Writes JSON report to desktop/scripts/.tmp-forensic-resolve-eval.json
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
const ROOT = path.join(FORENSIC, ".ai-test/test-cases");
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".tmp-forensic-resolve-eval.json"
);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/^TC-.*\.md$/i.test(ent.name)) out.push(p);
  }
  return out;
}

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

function parseFront(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const body = raw.replace(/^---[\s\S]*?---\r?\n/, "");
  const get = (h) => {
    const re = new RegExp(
      `##\\s*${h}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s|$)`,
      "i"
    );
    const mm = body.match(re);
    return mm ? mm[1].trim() : "";
  };
  const fn =
    body.match(/\|\s*Function\s*\|\s*([^|]+)\|/i)?.[1]?.trim() ||
    meta.module ||
    "";
  return {
    meta,
    functionLabel: fn,
    steps: get("Steps"),
    expected: get("Expected Result"),
    testData: get("Test Data")
      .replace(/path:\s*.+$/gim, "")
      .replace(/code:\s*.+$/gim, "")
      .replace(/related:\s*.+$/gim, "")
      .replace(/#\s*auto-enriched[\s\S]*/i, "")
      .replace(/#\s*sut-resolve:[\s\S]*/i, "")
      .trim(),
    pre: get("Precondition"),
  };
}

function tcFromMd(filePath) {
  const { meta, functionLabel, steps, expected, testData, pre } = parseFront(
    fs.readFileSync(filePath, "utf8")
  );
  return {
    id: meta.id || path.basename(filePath),
    projectId: meta.projectId || "forensic",
    testCaseId: meta.testCaseId || path.basename(filePath, ".md"),
    title: meta.title || "",
    module: functionLabel || meta.module || "",
    type: "Unit",
    priority: meta.priority || "Cao",
    severity: meta.severity || "Nặng",
    steps,
    expectedResult: expected,
    testData,
    precondition: pre,
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "Pending",
    createdAt: "2026-01-01T00:00:00Z",
    _requirement: meta.requirement || meta.module || "",
    _file: filePath,
  };
}

/** Portable expected family heuristics from Function/Title (eval only). */
function expectFamily(tc) {
  const blob = [tc._requirement, tc.module, tc.title, tc.steps]
    .join("\n")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/nguoi\s*(so\s*huu|su\s*dung|lien\s*quan)/.test(blob)) return "CasePerson";
  if (/hinh\s*anh|tai\s*len.*anh|anh\s*vat|xoa\s*hinh/.test(blob))
    return "PhysicalImage|DigitalFile|Upload";
  if (/thiet\s*bi|imei|ky\s*thuat\s*so/.test(blob) && !/khong\s*phai\s*ky\s*thuat/.test(blob))
    return "DigitalDevice";
  if (/vi\s*tri|luu\s*tru|phong\s*luu|tu\s*luu|ngan/.test(blob))
    return "StorageRoom|AssignEvidence";
  if (/gan\s*ho\s*so|ho\s*so\s*vu\s*an/.test(blob)) return "EvidenceAssignCase|AssignCase";
  if (/phan\s*loai|classification/.test(blob)) return "Evidence|Classification";
  if (/mo\s*ta.*khong\s*phai\s*ky\s*thuat|khong\s*phai\s*ky\s*thuat\s*so/.test(blob))
    return "EvidenceCreate|EvidenceUpdate";
  if (/thu\s*giu|trang\s*thai\s*vat/.test(blob)) return "EvidenceCreate|EvidenceUpdate";
  if (/tao\s*moi\s*vat|nhap\s*ma|ten\s*vat/.test(blob)) return "EvidenceCreate";
  return "Evidence*";
}

function familyHit(pathRel, expect) {
  if (!pathRel) return false;
  const p = pathRel.replace(/\\/g, "/");
  const alts = expect.split("|");
  return alts.some((a) => {
    if (a.endsWith("*")) {
      const stem = a.slice(0, -1);
      return new RegExp(stem, "i").test(p);
    }
    return new RegExp(a, "i").test(p);
  });
}

function line(td, re) {
  return (td || "").split(/\r?\n/).find((l) => re.test(l)) || "";
}

const raw = fs.readFileSync(path.join(FORENSIC, ".ai-test/index.db"), "utf8");
const codeIndex = normalizeSnap(parseSnapshotJson(raw), FORENSIC);
const index = buildProjectIndex(Object.keys(codeIndex.files));

const files = walk(ROOT).sort();
const rows = [];
for (const file of files) {
  const tc = tcFromMd(file);
  const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
    requirementTitle: tc._requirement || "Tạo mới vật chứng",
    projectRoot: FORENSIC,
    projectAliases: {},
    codeIndex,
    pickFromShortlist: null,
    readExcerpt: async (rel) => {
      try {
        return fs.readFileSync(path.join(FORENSIC, rel), "utf8");
      } catch {
        return "";
      }
    },
  });
  const pathLine = line(hit.testData, /^\s*path\s*:/i);
  const codeLine = line(hit.testData, /^\s*code\s*:/i);
  const pathRel = pathLine.replace(/^\s*path\s*:\s*/i, "").trim();
  const code = codeLine.replace(/^\s*code\s*:\s*/i, "").trim();
  const expect = expectFamily(tc);
  const okFamily = hit.enriched && familyHit(pathRel, expect);
  const wrongFamily = hit.enriched && pathRel && !okFamily;
  rows.push({
    tc: tc.testCaseId,
    function: tc.module,
    title: (tc.title || "").slice(0, 80),
    expect,
    enriched: hit.enriched,
    writeBack: hit.writeBack,
    skipReason: (hit.skipReason || "").slice(0, 120),
    path: pathRel,
    code,
    okFamily,
    wrongFamily,
    verdict: !hit.enriched
      ? "SKIP"
      : okFamily
        ? "OK"
        : "WRONG",
  });
}

const summary = {
  total: rows.length,
  ok: rows.filter((r) => r.verdict === "OK").length,
  wrong: rows.filter((r) => r.verdict === "WRONG").length,
  skip: rows.filter((r) => r.verdict === "SKIP").length,
  skipBuckets: {},
  wrongSamples: rows.filter((r) => r.verdict === "WRONG"),
  skipSamples: rows.filter((r) => r.verdict === "SKIP"),
  okSamples: rows.filter((r) => r.verdict === "OK").slice(0, 15),
};
for (const r of summary.skipSamples) {
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

fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      total: summary.total,
      ok: summary.ok,
      wrong: summary.wrong,
      skip: summary.skip,
      skipBuckets: summary.skipBuckets,
      wrongList: summary.wrongSamples.map((r) => ({
        tc: r.tc,
        expect: r.expect,
        code: r.code,
        fn: r.function,
      })),
      skipTop: summary.skipSamples.slice(0, 25).map((r) => ({
        tc: r.tc,
        skip: r.skipReason,
        fn: r.function,
      })),
      out: OUT,
    },
    null,
    2
  )
);
