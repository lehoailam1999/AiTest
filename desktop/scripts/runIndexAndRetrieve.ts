/**
 * Index + sample retrieve against a real project.
 * Usage: npx tsx scripts/runIndexAndRetrieve.ts <projectRoot>
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  CODE_INDEX_EXTENSIONS,
  lookupSymbol,
  syncProjectIndex,
  type CodeIndexIo,
} from "../src/lib/codeIndex/index.ts";
import { shouldIndexPath } from "../src/lib/codeIndex/constants.ts";
import { planFromTestCase } from "../src/lib/testPlanner/index.ts";
import { retrieveForPlan } from "../src/lib/retrieval/index.ts";

function createNodeIo(): CodeIndexIo {
  return {
    listFiles: async (projectRoot, extensions) => {
      const exts = extensions.length ? extensions : [...CODE_INDEX_EXTENSIONS];
      const out: string[] = [];
      async function walk(dir: string, relBase: string) {
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
          if (ent.isDirectory()) {
            const lower = ent.name.toLowerCase();
            if (
              lower === "node_modules" ||
              lower === "dist" ||
              lower === "build" ||
              lower === ".git" ||
              lower === ".ai-test"
            ) {
              continue;
            }
            await walk(path.join(dir, ent.name), rel.replace(/\\/g, "/"));
          } else if (ent.isFile()) {
            const norm = rel.replace(/\\/g, "/");
            if (shouldIndexPath(norm) || exts.some((e) => norm.toLowerCase().endsWith(e))) {
              if (shouldIndexPath(norm)) out.push(norm);
            }
          }
        }
      }
      await walk(projectRoot, "");
      return out;
    },
    readFile: async (projectRoot, pathRel) =>
      fs.readFile(path.join(projectRoot, pathRel), "utf8"),
    writeFile: async (projectRoot, pathRel, content) => {
      const full = path.join(projectRoot, pathRel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    },
    readFileOptional: async (projectRoot, pathRel) => {
      try {
        return await fs.readFile(path.join(projectRoot, pathRel), "utf8");
      } catch {
        return null;
      }
    },
  };
}

async function main() {
  const root = process.argv[2] || "D:\\Xlab\\Forensic\\forensic";
  console.log("=== Index ===");
  console.log("root:", root);
  const io = createNodeIo();
  const t0 = Date.now();
  const result = await syncProjectIndex(root, io);
  console.log(
    JSON.stringify(
      {
        elapsedMs: result.elapsedMs,
        wallMs: Date.now() - t0,
        scanned: result.scanned,
        parsed: result.parsed,
        reused: result.reused,
        fileCount: result.snapshot.meta.fileCount,
        symbolCount: result.snapshot.meta.symbolCount,
        edgeCount: result.snapshot.meta.edgeCount,
        indexRelPath: result.indexRelPath,
      },
      null,
      2
    )
  );

  // Sample lookups
  const probes = ["App", "User", "Case", "Evidence", "Auth", "Login", "Handler"];
  console.log("\n=== lookupSymbol samples ===");
  for (const name of probes) {
    const hits = lookupSymbol(result.snapshot, name, { limit: 3 });
    if (hits.length) {
      console.log(
        name + ":",
        hits.map((h) => `${h.kind}@${h.pathRel}:${h.line}`).join(" | ")
      );
    }
  }

  console.log("\n=== Retrieve Unit (sample TC) ===");
  const unitTc = {
    title: "Create case validates evidence",
    type: "Unit",
    module: "Case",
    steps: "Mock EvidenceService; Call CaseService.create; Assert",
    expectedResult: "case created",
  };
  const unitPlan = planFromTestCase(unitTc);
  const unitRet = retrieveForPlan(result.snapshot, unitPlan, unitTc, { topK: 8 });
  console.log("plan:", unitPlan.testType, unitPlan.module, unitPlan.keywords.slice(0, 8));
  console.log(
    "top files:",
    unitRet.files.files.map((f) => `${f.rankScore}:${f.pathRel}`).slice(0, 8)
  );

  console.log("\n=== Retrieve E2E (sample TC) ===");
  const e2eTc = {
    title: "Login page submit",
    type: "E2E",
    module: "Auth",
    testData: "path: /login",
    steps: "Fill credentials; Click login; see dashboard",
    expectedResult: "redirect home",
  };
  const e2ePlan = planFromTestCase(e2eTc);
  const e2eRet = retrieveForPlan(result.snapshot, e2ePlan, e2eTc, { topK: 8 });
  console.log("plan:", e2ePlan.testType, e2ePlan.hints.featurePath);
  console.log(
    "top files:",
    e2eRet.files.files.map((f) => `${f.rankScore}:${f.pathRel}`).slice(0, 8)
  );

  // Second sync should reuse
  console.log("\n=== Incremental re-sync ===");
  const second = await syncProjectIndex(root, io);
  console.log({ parsed: second.parsed, reused: second.reused, elapsedMs: second.elapsedMs });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
