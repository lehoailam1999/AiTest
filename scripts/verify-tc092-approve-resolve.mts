/**
 * Phase 6 — verify Approve enrich for TC-092-style size-limit Unit TC on Forensic (or fixture).
 * Usage: npx tsx scripts/verify-tc092-approve-resolve.mts [projectRoot]
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hasUnitSourceMarkers } from "../packages/ide-protocol/src/unitGenGuards.ts";
import { enrichTcTestDataFromIndexAsync } from "../desktop/src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts";
import { buildProjectIndex } from "../desktop/src/lib/projectIntelligence/projectIndex.ts";
import type { TestCase } from "../desktop/src/api/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULT_ROOT = "D:/Xlab/Forensic/forensic";

const EXPECTED_ENTRY = /UploadService\.cs$/i;
const FORBID_RELATED = /resumable-upload|\.pipe\.|\.component\.|\.constant\./i;

async function walkSourceRels(root: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set([
    "node_modules",
    ".git",
    "bin",
    "obj",
    "dist",
    "coverage",
    ".ai-test",
    "aitest",
  ]);
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skip.has(ent.name.toLowerCase())) continue;
        if (/^(test|tests|__tests__)$/i.test(ent.name)) continue;
        await walk(abs);
        continue;
      }
      if (!/\.(cs|ts|tsx|js)$/i.test(ent.name)) continue;
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (/\.(spec|test)\./i.test(rel)) continue;
      out.push(rel);
    }
  }
  await walk(root);
  return out;
}

function sampleTc(): TestCase {
  return {
    id: "00000000-0000-0000-0000-000000000092",
    projectId: "forensic",
    testCaseId: "TC-092",
    title: "Tải lên tệp - vượt dung lượng - Từ chối",
    module: "Tải lên tệp kỹ thuật số của vật chứng",
    type: "Unit",
    priority: "High",
    severity: "Major",
    steps: "Assert reject when FileSize > MaxFileSize",
    expectedResult: "ArgumentException",
    precondition: "Mock maxConfig",
    testData: "trace: NFR size limit",
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "Pending",
    createdAt: new Date().toISOString(),
  };
}

async function main() {
  const root = path.resolve(process.argv[2] || DEFAULT_ROOT);
  console.log(`Phase 6 verify TC-092 against: ${root}`);

  const st = await fs.stat(root).catch(() => null);
  if (!st?.isDirectory()) {
    console.error("FAIL: project root not found");
    process.exit(2);
  }

  const paths = await walkSourceRels(root);
  console.log(`Indexed source files: ${paths.length}`);
  assert.ok(
    paths.some((p) => EXPECTED_ENTRY.test(p)),
    "UploadService.cs must exist under project"
  );

  const index = buildProjectIndex(paths);
  const aliasesRaw = await fs
    .readFile(path.join(root, ".ai-test", "code-aliases.json"), "utf8")
    .catch(() => null);
  const projectAliases = aliasesRaw
    ? (JSON.parse(aliasesRaw) as Record<string, string[]>)
    : { "vat chung": ["Evidence"] };

  const hit = await enrichTcTestDataFromIndexAsync(sampleTc(), index, {
    requirementTitle: "Vật chứng",
    projectAliases,
    projectRoot: root,
    limit: 8,
    readExcerpt: async (rel) => {
      try {
        return await fs.readFile(path.join(root, rel), "utf8");
      } catch {
        return null;
      }
    },
  });

  console.log("--- enrich result ---");
  console.log(`enriched=${hit.enriched} writeBack=${hit.writeBack}`);
  console.log(`path=${hit.pathRel || "-"}`);
  console.log(`code=${hit.code || "-"}`);
  console.log(`ruleHits=${(hit.ruleHits || []).join(",") || "-"}`);
  console.log(`related=${(hit.relatedPaths || []).join(" | ") || "-"}`);
  console.log(`bodyRuleLog=${hit.bodyRuleLog || "-"}`);
  if (!hit.enriched) {
    console.log(`skipReason=${hit.skipReason || "-"}`);
    console.log("--- testData ---");
    console.log(hit.testData);
  }

  assert.equal(hit.enriched, true, `expected write-back: ${hit.skipReason || hit.testData}`);
  assert.ok(hit.pathRel && EXPECTED_ENTRY.test(hit.pathRel), `entry must be UploadService.cs, got ${hit.pathRel}`);
  assert.equal(hit.code, "UploadService");
  assert.ok((hit.ruleHits || []).length >= 1, "body-rule hits required");
  assert.ok(
    !(hit.relatedPaths || []).some((p) => FORBID_RELATED.test(p)),
    `related must not include FE: ${(hit.relatedPaths || []).join(", ")}`
  );
  assert.ok((hit.relatedPaths || []).length <= 4);
  assert.ok(hasUnitSourceMarkers(hit.testData), "Test Data must have path:+code:");

  // Import from correct module — hasUnitSourceMarkers is in unitGenGuards
  console.log("PASS: TC-092 Approve resolve → UploadService + related ≤4, no resumable FE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
