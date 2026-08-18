import type { ProjectProfile } from "./types.js";
import { renderUnitConventionsMd } from "./unitConventionsCore.js";
import { E2E_CONVENTIONS_CORE } from "./e2eConventionsCore.js";

export { renderUnitConventionsMd, UNIT_CONVENTIONS_CORE } from "./unitConventionsCore.js";
export { E2E_CONVENTIONS_CORE } from "./e2eConventionsCore.js";

export function renderE2eConventionsMd(profile: ProjectProfile): string {
  const lines: string[] = [
    E2E_CONVENTIONS_CORE,
    "",
    "## Project profile hints",
    "",
    `Runner: **${profile.runner}** · Test root: \`${profile.testRoot}\``,
    "",
    "### Locator priority",
    profile.locatorPolicy.map((p, i) => `${i + 1}. ${p}`).join("\n"),
    "",
    "### Auth",
    `- Strategy: ${profile.auth.strategy}`,
    `- Storage dir: ${profile.auth.storageDir}`,
  ];
  if (profile.auth.roles?.length) {
    lines.push(`- Default roles: ${profile.auth.roles.join(", ")}`);
  }
  lines.push(
    "",
    "### Layout (AITest artifact)",
    "- E2E → `AItest/E2ETest/{Requirement}/{TC}/specs` + `_shared/{pages|fixtures}`",
    "- Do not invent `featurePath` without TC marker, moduleMap, or route catalog.",
    "",
    "### Forbidden (engine + project)",
    "- Generic `main|nav|h1` as business assert (R6)",
    "- Placeholder test data / invent route without evidence",
    "- Phase-3 ungrounded POM stubs in committed Spec/POM"
  );
  if (profile.playwrightRun?.testIdAttribute) {
    lines.push(`- Prefer test id attribute: \`${profile.playwrightRun.testIdAttribute}\``);
  }
  if (profile.reuseRoots.length) {
    lines.push("", "### Reuse roots", profile.reuseRoots.map((r) => `- ${r}`).join("\n"));
  }
  if (Object.keys(profile.moduleMap).length) {
    lines.push("", "### moduleMap (TC module / Function title → AbsolutePath)", "");
    lines.push(
      "- Key = Requirement/Function title from TC; value = real UI route (ASCII AbsolutePath).",
      "- Approve + Gen use this when TC has no usable `path:`/`featurePath:`.",
      "- Do not invent routes from Vietnamese title slugs.",
      ""
    );
    for (const [mod, route] of Object.entries(profile.moduleMap)) {
      lines.push(`- ${mod} → ${route}`);
    }
  } else {
    lines.push(
      "",
      "### moduleMap",
      "",
      "- Empty — add entries in `.ai-test/project.profile.json` so Approve can fill `path:` for feature TCs.",
      "- Route catalog (source routing files) is the portable fallback when Latin tokens overlap path segments."
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderAllConventionFiles(profile: ProjectProfile): Record<string, string> {
  // Verify reads profile.playwrightRun JSON only — no e2e-playwright-run.md.
  return {
    ".ai-test/e2e-conventions.md": renderE2eConventionsMd(profile),
    ".ai-test/unit-conventions.md": renderUnitConventionsMd(profile),
    ".ai-test/.gitignore": ["staging/", "logs/", "workspace/", ""].join("\n"),
  };
}
