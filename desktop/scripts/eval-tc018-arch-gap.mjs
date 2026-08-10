/**
 * Live gap check: TC-018 real MD × index.db × empty aliases vs aliases.
 * No IDE needed for Approve markers (index.db path).
 */
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
    testData: get("Test Data").replace(/# sut-resolve:[\s\S]*/i, "").trim(),
    pre: get("Precondition"),
  };
}

function line(td, re) {
  return (td || "").split(/\r?\n/).find((l) => re.test(l)) || "";
}

async function run(tc, aliases, codeIndex, index) {
  const hit = await enrichTcTestDataFromIndexAsync(tc, index, {
    requirementTitle: "Vật chứng",
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
  return {
    enriched: hit.enriched,
    skipReason: hit.skipReason || null,
    path: line(hit.testData, /^\s*path\s*:/i),
    code: line(hit.testData, /^\s*code\s*:/i),
  };
}

const caseDirs = fs.readdirSync(path.join(FORENSIC, ".ai-test/test-cases"));
const with018 = caseDirs.find((d) =>
  fs.existsSync(path.join(FORENSIC, ".ai-test/test-cases", d, "TC-018.md"))
);
if (!with018) {
  console.error("TC-018.md not found under Forensic test-cases");
  process.exit(2);
}
const caseDir = path.join(FORENSIC, ".ai-test/test-cases", with018);
const { meta, steps, expected, testData, pre } = parseFront(
  fs.readFileSync(path.join(caseDir, "TC-018.md"), "utf8")
);
const tc = {
  id: meta.id,
  projectId: meta.projectId,
  testCaseId: "TC-018",
  title: meta.title,
  module: meta.module,
  type: "Unit",
  priority: "H",
  severity: "H",
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

const codeIndex = normalizeSnap(
  parseSnapshotJson(fs.readFileSync(path.join(FORENSIC, ".ai-test/index.db"), "utf8")),
  FORENSIC
);
const index = buildProjectIndex(Object.keys(codeIndex.files));
const intent = extractUnitIntent(tc, {
  requirementTitle: "Vật chứng",
  projectAliases: {},
});
const qEmpty = buildUnitApproveQuery(tc, {
  requirementTitle: "Vật chứng",
  projectAliases: {},
  intent,
});
const qAlias = buildUnitApproveQuery(tc, {
  requirementTitle: "Vật chứng",
  projectAliases: { "vật chứng": ["Evidence"], "vat chung": ["Evidence"] },
});

const out = {
  architectureNote:
    "Approve PATH+CODE uses index.db retrieve+rank+body-rule — NOT IDE File/Symbol/Text search (that is Gen/agentRetrieve)",
  mdOnDiskStillSkipped: true,
  aliasesFileOnDisk: fs.existsSync(
    path.join(FORENSIC, ".ai-test/code-aliases.json")
  ),
  intent: {
    primary: intent.primaryClass,
    requiresBodyRule: intent.requiresBodyRule,
    classes: intent.classes,
  },
  preferTokensEmpty: qEmpty.preferTokens.slice(0, 10),
  preferTokensWithAlias: qAlias.preferTokens.slice(0, 10),
  liveEmptyAliases: await run(tc, {}, codeIndex, index),
  liveWithAliases: await run(
    tc,
    { "vật chứng": ["Evidence"], "vat chung": ["Evidence"] },
    codeIndex,
    index
  ),
};
console.log(JSON.stringify(out, null, 2));
if (!out.liveEmptyAliases.enriched && !out.liveWithAliases.enriched) {
  process.exitCode = 2;
}
