/**
 * Tauri-backed IO for Project Profile (Desktop).
 */
import { listSourceFiles, readTextFile, writeTextFile } from "../../tauri/bridge";
import type { ProfileIo } from "./types.js";

export function createTauriProfileIo(): ProfileIo {
  return {
    listFiles: (projectRoot, extensions) =>
      listSourceFiles(projectRoot, extensions ?? undefined),
    readFile: (projectRoot, pathRel) => readTextFile(projectRoot, pathRel),
    writeFile: async (projectRoot, pathRel, content) => {
      await writeTextFile(projectRoot, pathRel, content);
    },
    readFileOptional: async (projectRoot, pathRel) => {
      try {
        return await readTextFile(projectRoot, pathRel);
      } catch {
        return null;
      }
    },
    fileExists: async (projectRoot, pathRel) => {
      try {
        await readTextFile(projectRoot, pathRel);
        return true;
      } catch {
        return false;
      }
    },
  };
}
