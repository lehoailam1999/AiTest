import {
  deleteUnitDraftDir,
  readUnitDraftText,
  writeUnitDraftText,
} from "../../tauri/bridge";

/** All paths are opaque keys under the Tool's OS-temp draft root. */
export async function readDraftText(
  projectRoot: string,
  draftPath: string
): Promise<string> {
  return readUnitDraftText(projectRoot, draftPath);
}

export async function writeDraftText(
  projectRoot: string,
  draftPath: string,
  content: string
): Promise<void> {
  await writeUnitDraftText(projectRoot, draftPath, content);
}

export async function writeDraftTextIfChanged(
  projectRoot: string,
  draftPath: string,
  content: string
): Promise<boolean> {
  try {
    if ((await readDraftText(projectRoot, draftPath)) === content) return false;
  } catch {
    /* new draft */
  }
  await writeDraftText(projectRoot, draftPath, content);
  return true;
}

export async function deleteDraftPath(
  projectRoot: string,
  draftPath: string
): Promise<void> {
  await deleteUnitDraftDir(projectRoot, draftPath);
}
