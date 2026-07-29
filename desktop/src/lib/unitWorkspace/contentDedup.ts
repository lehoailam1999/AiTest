/**
 * Avoid rewriting files that already have identical content (staging/apply/scaffold).
 * Keeps verify working: shared AItest/jest + tsconfig stay on disk once.
 */
import { readTextFile, writeTextFile } from "../../tauri/bridge";

/** Pure compare — skip write/overlay when disk already has the same bytes. */
export function isIdenticalContent(existing: string | null, next: string): boolean {
  return existing !== null && existing === next;
}

export async function readTextFileOrNull(
  projectRoot: string,
  rel: string
): Promise<string | null> {
  try {
    return await readTextFile(projectRoot, rel);
  } catch {
    return null;
  }
}

export async function textFileEquals(
  projectRoot: string,
  rel: string,
  content: string
): Promise<boolean> {
  const existing = await readTextFileOrNull(projectRoot, rel);
  return isIdenticalContent(existing, content);
}

/**
 * Write only when missing or content differs.
 * @returns true if a write happened
 */
export async function writeTextFileIfChanged(
  projectRoot: string,
  rel: string,
  content: string
): Promise<boolean> {
  if (await textFileEquals(projectRoot, rel, content)) {
    return false;
  }
  await writeTextFile(projectRoot, rel, content);
  return true;
}
