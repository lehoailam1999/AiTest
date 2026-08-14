/**
 * Shared path jail + E2E env allowlist for Extension Apply/Run.
 * Mirrors desktop/src/lib/testOutputLayout.assertSafeAitestTargetRel.
 */
export declare function assertSafeAitestTargetRel(targetRel: string): string;
/**
 * Unit Apply paths: real tests under UnitTest/, plus AItest-root scaffolding
 * (AItest.UnitTests.csproj, jest.config, tsconfig) — not nested production mirrors.
 */
export declare function isAllowedUnitLayoutPath(safeRel: string): boolean;
export declare function isAllowedE2eEnvKey(key: string): boolean;
export declare function filterAllowedEnv(env: Record<string, string> | undefined): Record<string, string>;
