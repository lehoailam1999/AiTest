/** Product IA — một chu trình rõ (Design → Automate). */

export const ROUTES = {
  home: "/",
  projects: "/projects",
  /** Hub: yêu cầu · chức năng · TC · duyệt */
  requirement: "/requirement",
  /**
   * @deprecated FE Workspace Host removed. Redirects to unitTest.
   * Prefer ROUTES.unitTest. BE `/api/workspace/*` unchanged.
   */
  workspace: "/workspace",
  /** Automate: Sinh mã Unit test (IDE-first) */
  unitTest: "/unit-test",
  run: "/run",
  reports: "/reports",
  activity: "/activity",
  settingsAi: "/settings/ai",
  /** Deep-link wizards (không lên sidebar) */
  generateTc: "/generate/tc",
  spec: "/spec",
} as const;

export function requirementUrl(opts?: {
  tab?: "home" | "studio" | "board" | "review" | "edit";
  workspaceId?: string;
  /** Studio pane. Legacy analyze/coverage/chat → knowledge. */
  stage?: "docs" | "knowledge" | "freeze" | "analyze" | "coverage" | "chat";
  module?: string;
}): string {
  const q = new URLSearchParams();
  const tab = opts?.tab ?? (opts?.workspaceId ? "studio" : "home");
  if (tab !== "home") q.set("tab", tab);
  if (opts?.workspaceId) q.set("workspaceId", opts.workspaceId);
  if ((tab === "studio" || tab === "home") && opts?.stage && opts.stage !== "docs") {
    const stage =
      opts.stage === "analyze" ||
      opts.stage === "coverage" ||
      opts.stage === "chat"
        ? "knowledge"
        : opts.stage;
    q.set("stage", stage);
  }
  if (opts?.module) q.set("module", opts.module);
  const s = q.toString();
  return s ? `${ROUTES.requirement}?${s}` : ROUTES.requirement;
}

export function unitTestUrl(opts?: {
  mode?: "module" | "single" | "gaps";
  module?: string;
  modules?: string;
  testCaseId?: string;
}): string {
  const q = new URLSearchParams();
  q.set("artifact", "unit");
  if (opts?.mode) q.set("mode", opts.mode);
  if (opts?.module) q.set("module", opts.module);
  if (opts?.modules) q.set("modules", opts.modules);
  if (opts?.testCaseId) q.set("testCaseId", opts.testCaseId);
  return `${ROUTES.unitTest}?${q.toString()}`;
}

/** Prefixes that highlight Requirement in sidebar */
export const REQUIREMENT_MATCH = [
  "/requirement",
  "/coverage",
  "/spec",
  "/generate/tc",
  "/requirements",
  "/testcases",
] as const;

export const UNIT_TEST_MATCH = [
  "/unit-test",
  "/generate/code",
  "/generate-unit",
] as const;

export function pathMatches(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`));
}
