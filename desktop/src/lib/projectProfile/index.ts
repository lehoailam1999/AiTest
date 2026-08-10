import { discoverProjectProfile } from "./discoverProjectProfile.js";
import {
  loadProjectProfile,
  mergeProjectProfile,
  saveProjectProfile,
  readConventionExcerpt,
  CONVENTION_PATHS,
} from "./loadSaveProfile.js";
import { renderAllConventionFiles } from "./renderConventions.js";
import { createTauriProfileIo } from "./tauriIo.js";
import type { DiscoverResult, ProfileIo, ProjectProfile } from "./types.js";

export type { DiscoverResult, ProfileIo, ProjectProfile };
export type {
  PlaywrightRunProfile,
  AuthProfile,
  UnitProfile,
  StorageStateProfile,
} from "./types.js";
export {
  CONVENTION_PATHS,
  readConventionExcerpt,
  loadProjectProfile,
  mergeProjectProfile,
  discoverProjectProfile,
};
export { renderAllConventionFiles } from "./renderConventions.js";
export { renderUnitConventionsMd, UNIT_CONVENTIONS_CORE } from "./unitConventionsCore.js";
export { createTauriProfileIo } from "./tauriIo.js";
export { createEmptyProfile, normalizeUnitProfile } from "./loadSaveProfile.js";
export {
  resolveProfileForVerify,
  applyStorageStateToVerifyFiles,
  formatVerifyProfileLog,
  resolveVerifyStorageStateRel,
} from "./resolveForVerify.js";
export type { VerifyProfileContext, VerifyProfileUiFallback } from "./resolveForVerify.js";
export { isValidStorageStateJson, findValidStorageStateInFiles } from "./storageStateValidation.js";

/**
 * Discover → merge existing → persist profile + convention markdown on SUT.
 */
export async function discoverAndPersistProjectProfile(
  projectRoot: string,
  io?: ProfileIo
): Promise<DiscoverResult> {
  const profileIo = io ?? createTauriProfileIo();
  const { profile: discovered, notes } = await discoverProjectProfile(projectRoot, profileIo);
  const existing = await loadProjectProfile(projectRoot, profileIo);
  const merged = mergeProjectProfile(existing, discovered);
  const conventionFiles = renderAllConventionFiles(merged);
  await saveProjectProfile(projectRoot, merged, profileIo, conventionFiles);
  return { profile: merged, notes };
}
