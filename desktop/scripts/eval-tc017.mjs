import fs from "node:fs";
import path from "node:path";
import { buildProjectIndex } from "../src/lib/projectIntelligence/projectIndex.ts";
import {
  enrichTcTestDataFromIndexAsync,
  toRepoRelativePath,
} from "../src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts";
import { parseSnapshotJson } from "../src/lib/codeIndex/indexStore.ts";
import { buildUnitApproveQuery } from "../src/lib/unitResolve/buildUnitApproveQuery.ts";
import { extractUnitIntent } from "@aitest/ide-protocol";

const FORENSIC = "D:/Xlab/Forensic/forensic";
const md = fs.readFileSync(
  "D:/Xlab/Forensic/forensic/.ai-test/test-cases/Tạo-mới-vật-chứng/TC-017.md",
  "utf8"
);

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
    testData: get("Test Data"),
    pre: get("Precondition"),
  };
}

function normalizeSnap(rawSnap, projectRoot) {
  const snap = structuredClone(rawSnap);
  const files = {};
  const symbolsByFile = {};
  const symbolIndex = {};
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

const { meta, steps, expected, testData, pre } = parseFront(md);
const tc = {
  id: meta.id || "x",
  projectId: meta.projectId || "p",
  testCaseId: meta.testCaseId || "TC-017",
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

let aliases = {};
const ap = path.join(FORENSIC, ".ai-test/code-aliases.json");
if (fs.existsSync(ap)) aliases = JSON.parse(fs.readFileSync(ap, "utf8"));

const codeIndex = normalizeSnap(
  parseSnapshotJson(fs.readFileSync(path.join(FORENSIC, ".ai-test/index.db"), "utf8")),
  FORENSIC
);
const index = buildProjectIndex(Object.keys(codeIndex.files));
const intent = extractUnitIntent(tc, {
  requirementTitle: meta.requirement || "Vật chứng",
  projectAliases: aliases,
});
const q = buildUnitApproveQuery(tc, {
  requirementTitle: meta.requirement || "Vật chứng",
  projectAliases: aliases,
  intent,
});

const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
  requirementTitle: meta.requirement || "Vật chứng",
  projectRoot: FORENSIC,
  projectAliases: aliases,
  codeIndex,
  readExcerpt: async (rel) => {
    try {
      return fs.readFileSync(path.join(FORENSIC, rel), "utf8");
    } catch {
      return "";
    }
  },
});

const pathLine =
  (hit.testData || "").split(/\r?\n/).find((l) => /^\s*path\s*:/i.test(l)) || "";
const codeLine =
  (hit.testData || "").split(/\r?\n/).find((l) => /^\s*code\s*:/i.test(l)) || "";

console.log(
  JSON.stringify(
    {
      title: tc.title,
      intent: {
        primary: intent.primaryClass,
        classes: intent.classes,
        uiOnly: intent.uiOnly,
      },
      enriched: hit.enriched,
      writeBack: hit.writeBack,
      skipReason: hit.skipReason,
      pathLine,
      codeLine,
      mdAlreadySaid: "FAIL_FEATURE_GAP ui_master_create + scope=backend",
    },
    null,
    2
  )
);
