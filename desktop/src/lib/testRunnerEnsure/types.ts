/** Ensure test runner — detect / lock / propose install (P5.6). */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "dotnet" | "pip" | "unknown";

export type TestFrameworkId =
  | "vitest"
  | "jest"
  | "mocha"
  | "xunit"
  | "nunit"
  | "mstest"
  | "pytest"
  | "unittest"
  | "junit"
  | "gotest"
  | "phpunit"
  | "auto";

export type EnsureStatus =
  | "idle"
  | "checking"
  | "ready"
  | "needs_install"
  | "installing"
  | "error";

export type TestFrameworkResolution = {
  status: "present" | "missing" | "unknown";
  /** Canonical id for GenerateUnit framework select */
  framework: TestFrameworkId;
  label: string;
  /** Why we picked this */
  reason: string;
  packageManager: PackageManager;
  /** Packages to add when missing (empty when present) */
  packages: string[];
  /** Full shell command when missing */
  installCommand: string | null;
  /** Evidence strings (dep names, stacks, …) */
  evidence: string[];
  locked: boolean;
};
