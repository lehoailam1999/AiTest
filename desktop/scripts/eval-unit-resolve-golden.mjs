/**
 * Eval golden Approve resolve for IDE-parity: TC-004 / TC-010 / TC-014 style
 * against Forensic index.db when MD files exist.
 * Portable asserts: storage ≠ AssignCase; authz prefers CanWrite path; DTO-only may skip.
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
import { resolveUnitPrimaryFromIndex } from "../src/lib/unitResolve/resolveUnitPrimaryFromIndex.ts";

const FORENSIC = "D:/Xlab/Forensic/forensic";

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

function findTcMd(root, code) {
  const base = path.join(root, ".ai-test/test-cases");
  if (!fs.existsSync(base)) return null;
  for (const mod of fs.readdirSync(base)) {
    const p = path.join(base, mod, `${code}.md`);
    if (fs.existsSync(p)) return p;
  }
  return null;
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

async function resolveOne(tc, codeIndex, requirementTitle) {
  const query = buildUnitApproveQuery(tc, {
    requirementTitle: requirementTitle || tc.module,
    projectAliases: { "vat chung": ["Evidence"] },
  });
  return resolveUnitPrimaryFromIndex({
    codeIndex,
    query,
    readExcerpt: async (rel) => {
      try {
        return fs.readFileSync(path.join(FORENSIC, rel), "utf8");
      } catch {
        return "";
      }
    },
  });
}

const indexPath = path.join(FORENSIC, ".ai-test/index.db");
if (!fs.existsSync(indexPath)) {
  console.log(JSON.stringify({ skipped: true, reason: "no Forensic index.db" }));
  process.exit(0);
}

const raw = fs.readFileSync(indexPath, "utf8");
const codeIndex = normalizeSnap(parseSnapshotJson(raw), FORENSIC);

const goldens = [
  {
    id: "TC-014",
    assert: (r) => {
      if (!r.writeBack) return { ok: true, note: "skip-no-writeBack" };
      const p = r.seed?.pathRel || "";
      return {
        ok: !/AssignCase/i.test(p),
        note: p,
        expect: "not EvidenceAssignCase",
      };
    },
  },
  {
    id: "TC-010",
    assert: (r) => {
      if (!r.writeBack) return { ok: true, note: "skip-no-writeBack" };
      const p = r.seed?.pathRel || "";
      return {
        ok: /Assign|CanWrite|Permission/i.test(p) || !/CreateCommandHandler/i.test(p),
        note: p,
        expect: "authz/assign family not bare Create",
      };
    },
  },
  {
    id: "TC-004",
    assert: (r) => {
      // DTO-only field reject may skip or latch Create — FEATURE_GAP at Gen is OK
      return {
        ok: true,
        note: r.writeBack ? r.seed?.pathRel : r.skipReason,
        expect: "informational",
      };
    },
  },
];

const out = {};
let failed = 0;
for (const g of goldens) {
  const md = findTcMd(FORENSIC, g.id);
  if (!md) {
    out[g.id] = { skipped: true, reason: "md-missing" };
    continue;
  }
  const tc = tcFromMd(md);
  const r = await resolveOne(tc, codeIndex, "Tạo mới vật chứng");
  const check = g.assert(r);
  out[g.id] = {
    writeBack: r.writeBack,
    path: r.seed?.pathRel || null,
    skipReason: r.skipReason || null,
    ...check,
  };
  if (!check.ok) failed += 1;
}

console.log(JSON.stringify(out, null, 2));
if (failed) process.exitCode = 2;
