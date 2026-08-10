/**
 * Seed `.ai-test/unit-conventions.md` from shared protocol SoT + profile hints.
 */
import {
  UNIT_CONVENTIONS_CORE,
  UNIT_GEN_LIMITS,
} from "@aitest/ide-protocol";
import type { ProjectProfile } from "./types.js";

export { UNIT_CONVENTIONS_CORE, UNIT_GEN_LIMITS };

export function renderUnitConventionsMd(profile: ProjectProfile): string {
  const unit = profile.unit;
  const lines: string[] = [UNIT_CONVENTIONS_CORE.trim(), ""];

  lines.push("## Project profile hints", "");
  lines.push(
    `Test frameworks: ${unit?.testFrameworks?.join(", ") || "(detect from project)"}`
  );
  lines.push(`Unit scope: ${unit?.scope || "backend"}`);
  lines.push(`Min alignment: ${unit?.minAlignment ?? 50}`);
  lines.push(
    `Disk re-resolve (Extension): ${unit?.allowDiskReresolve === true ? "on" : "off (default)"}`
  );
  lines.push(
    `Require markers: ${
      Array.isArray(unit?.requireMarkers)
        ? unit!.requireMarkers!.join(", ")
        : unit?.requireMarkers === false
          ? "false"
          : "path, code"
    }`
  );
  if (unit?.codeAliasesFile) {
    lines.push(`Code aliases file: ${unit.codeAliasesFile}`);
  }
  if (unit?.mockHint) {
    lines.push("", "### Mock / stack note", "", unit.mockHint);
  }
  lines.push("");
  return lines.join("\n");
}
