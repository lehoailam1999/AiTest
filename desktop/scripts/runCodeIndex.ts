/**
 * One-shot: index a real project folder with Node fs IO (no Tauri).
 * Usage: npx tsx scripts/runCodeIndex.ts <projectRoot>
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
  const root = process.argv[2] || "d:\\Todo\\frontend";
  console.log("Indexing:", root);
  const io = createNodeIo();
  const result = await syncProjectIndex(root, io);
  console.log(
    JSON.stringify(
      {
        indexRelPath: result.indexRelPath,
        scanned: result.scanned,
        parsed: result.parsed,
        reused: result.reused,
        removed: result.removed,
        elapsedMs: result.elapsedMs,
        fileCount: result.snapshot.meta.fileCount,
        symbolCount: result.snapshot.meta.symbolCount,
        edgeCount: result.snapshot.meta.edgeCount,
        sampleSymbols: Object.keys(result.snapshot.symbolIndex).slice(0, 15),
      },
      null,
      2
    )
  );
  const probe = ["App", "OrderService", "Todo", "Login", "User"];
  for (const name of probe) {
    const hits = lookupSymbol(result.snapshot, name, { limit: 3 });
    if (hits.length) {
      console.log(
        `lookup ${name}:`,
        hits.map((h) => `${h.kind}@${h.pathRel}:${h.line}`).join(", ")
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
