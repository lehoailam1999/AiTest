/**
 * Eval: unified Approve pipeline on Forensic index.db for TC-057 / TC-058.
 * Pass aliases empty — expect CheckCode family lock or LLM shortlist mock.
 */
import fs from "node:fs";
import path from "node:path";
import { buildProjectIndex } from "../src/lib/projectIntelligence/projectIndex.ts";
import {
  enrichTcTestDataFromIndexAsync,
  toRepoRelativePath,
} from "../src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts";
import { parseSnapshotJson } from "../src/lib/codeIndex/indexStore.ts";

const FORENSIC = "D:/Xlab/Forensic/forensic";

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

function line(td, re) {
  return (td || "").split(/\r?\n/).find((l) => re.test(l)) || "";
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
  return {
    meta,
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
  const { meta, steps, expected, testData, pre } = parseFront(
    fs.readFileSync(filePath, "utf8")
  );
  return {
    id: meta.id || "x",
    projectId: meta.projectId || "p",
    testCaseId: meta.testCaseId || path.basename(filePath, ".md"),
    title: meta.title,
    module: meta.module,
    type: "Unit",
    priority: meta.priority || "H",
    severity: meta.severity || "H",
    steps,
    expectedResult: expected,
    testData,
    precondition: pre,
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "Pending",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

async function runOne(tc, aliases, codeIndex, index, pickFromShortlist) {
  const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
    requirementTitle: tc.module || "Tạo mới vật chứng",
    projectRoot: FORENSIC,
    projectAliases: aliases,
    codeIndex,
    pickFromShortlist,
    readExcerpt: async (rel) => {
      try {
        return fs.readFileSync(path.join(FORENSIC, rel), "utf8");
      } catch {
        return "";
      }
    },
  });
  return {
    testCaseId: tc.testCaseId,
    enriched: hit.enriched,
    skipReason: hit.skipReason,
    pathLine: line(hit.testData, /^\s*path\s*:/i),
    codeLine: line(hit.testData, /^\s*code\s*:/i),
    pathOk: /path:\s*.*EvidenceCreateCommandHandler\.cs/i.test(hit.testData || ""),
  };
}

const raw = fs.readFileSync(path.join(FORENSIC, ".ai-test/index.db"), "utf8");
const codeIndex = normalizeSnap(parseSnapshotJson(raw), FORENSIC);
const index = buildProjectIndex(Object.keys(codeIndex.files));

const dir = path.join(
  FORENSIC,
  ".ai-test/test-cases",
  fs.readdirSync(path.join(FORENSIC, ".ai-test/test-cases"))[0]
);

const mockPick = async (input) => {
  const hit = input.shortlist.find((s) =>
    /EvidenceCreateCommandHandler/i.test(s.pathRel)
  );
  if (!hit) return null;
  return {
    pathRel: hit.pathRel,
    code: "EvidenceCreateCommandHandler",
    confidence: 0.95,
    source: "mock",
  };
};

const out = {
  tc057: await runOne(
    tcFromMd(path.join(dir, "TC-057.md")),
    {},
    codeIndex,
    index,
    mockPick
  ),
  tc058: await runOne(
    tcFromMd(path.join(dir, "TC-058.md")),
    {},
    codeIndex,
    index,
    mockPick
  ),
};
console.log(JSON.stringify(out, null, 2));
if (!out.tc057.pathOk || !out.tc058.pathOk) process.exitCode = 2;
