import type { ProjectProfile } from "./types.js";
import { renderUnitConventionsMd } from "./unitConventionsCore.js";

export { renderUnitConventionsMd, UNIT_CONVENTIONS_CORE } from "./unitConventionsCore.js";

export function renderE2eConventionsMd(profile: ProjectProfile): string {
  const lines: string[] = [
    "# E2E conventions (auto — project profile)",
    "",
    `Runner: **${profile.runner}** · Test root: \`${profile.testRoot}\``,
    "",
    "## Locator priority",
    profile.locatorPolicy.map((p, i) => `${i + 1}. ${p}`).join("\n"),
    "",
    "## Auth",
    `- Strategy: ${profile.auth.strategy}`,
    `- Storage dir: ${profile.auth.storageDir}`,
    "",
    "## Layout (AITest artifact)",
    "- E2E → `AItest/E2ETest/{Requirement}/{TC}/specs` + `_shared/{pages|fixtures}`",
    "- Do not invent `featurePath` without TC marker or moduleMap.",
    "",
    "## Forbidden (engine + project)",
    "- Generic `main|nav|h1` as business assert (R6)",
    "- Placeholder test data / invent route without evidence",
  ];
  if (profile.playwrightRun?.testIdAttribute) {
    lines.push(`- Prefer test id attribute: \`${profile.playwrightRun.testIdAttribute}\``);
  }
  if (profile.reuseRoots.length) {
    lines.push("", "## Reuse roots", profile.reuseRoots.map((r) => `- ${r}`).join("\n"));
  }
  if (Object.keys(profile.moduleMap).length) {
    lines.push("", "## moduleMap (TC module → route)", "");
    for (const [mod, route] of Object.entries(profile.moduleMap)) {
      lines.push(`- ${mod} → ${route}`);
    }
  }
  return lines.join("\n");
}

export function renderE2ePlaywrightRunMd(profile: ProjectProfile): string {
  const pw = profile.playwrightRun;
  if (!pw) {
    return "# E2E Playwright run\n\n(no playwrightRun block in profile)";
  }
  const run = pw.run ?? {
    workers: 1,
    timeoutMs: 90000,
    headless: false,
    slowMoMs: 500,
    browser: "chromium",
  };
  const lines: string[] = [
    "# E2E Playwright run (auto — do not inject LLM)",
    "",
    `Package root: ${pw.packageRoot || "(project root)"}`,
    `Work cwd: ${pw.workCwd}`,
    `Config pattern: ${pw.configPattern}`,
    `Base URL: ${pw.defaultBaseURL} (env ${pw.baseURLEnv})`,
    `Test id attribute: ${pw.testIdAttribute}`,
    "",
    "## storageState",
    `- Strategy: ${pw.storageState.strategy}`,
    `- Canonical (relative to TC config): ${pw.storageState.canonicalRel}`,
    `- Shared artifact: ${pw.storageState.sharedRel}`,
    `- Discover dirs: ${pw.storageState.discoverDirs.join(", ")}`,
    "",
    "## Run",
    `- Workers: ${run.workers}`,
    `- Timeout: ${run.timeoutMs}ms`,
    `- Headless: ${run.headless}`,
    `- Browser: ${run.browser}`,
    "",
    "## Env allowlist",
    pw.envAllowlist.map((e) => `- ${e}`).join("\n"),
  ];
  if (pw.seed.globalSetupRel) {
    lines.push("", `Global setup: ${pw.seed.globalSetupRel}`);
  }
  return lines.join("\n");
}

export function renderAllConventionFiles(profile: ProjectProfile): Record<string, string> {
  return {
    ".ai-test/e2e-conventions.md": renderE2eConventionsMd(profile),
    ".ai-test/e2e-playwright-run.md": renderE2ePlaywrightRunMd(profile),
    ".ai-test/unit-conventions.md": renderUnitConventionsMd(profile),
  };
}
