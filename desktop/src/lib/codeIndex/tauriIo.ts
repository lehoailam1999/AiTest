/**
 * Tauri-backed IO for Code Index (Desktop App).
 * Call only when `isTauri()` — otherwise inject a mock IO in tests / browser UI.
 */
import {
  listSourceFiles,
  readTextFile,
  writeTextFile,
} from "../../tauri/bridge";
import type { CodeIndexIo } from "./types";

export function createTauriCodeIndexIo(): CodeIndexIo {
  return {
    listFiles: (projectRoot, extensions) => listSourceFiles(projectRoot, extensions),
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
  };
}
