import { describe, expect, it } from "vitest";

/**
 * Path matching used by E2E staging edit/delete (mirrored for unit tests).
 */
function matchStagedPath(
  filePath: string,
  targetRel: string
): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "");
  const a = norm(filePath);
  const b = norm(targetRel);
  if (a === b) return true;
  const aBase = a.split("/").pop() || "";
  const bBase = b.split("/").pop() || "";
  return !!aBase && aBase === bBase && (a.endsWith(b) || b.endsWith(a));
}

describe("staging file path match", () => {
  it("matches exact and suffix paths", () => {
    expect(
      matchStagedPath(
        "AItest/E2ETest/Req/TC/specs/foo.spec.ts",
        "AItest/E2ETest/Req/TC/specs/foo.spec.ts"
      )
    ).toBe(true);
    expect(
      matchStagedPath(
        "AItest/E2ETest/Req/TC/specs/foo.spec.ts",
        "backend/AItest/E2ETest/Req/TC/specs/foo.spec.ts"
      )
    ).toBe(true);
    expect(
      matchStagedPath("specs/foo.spec.ts", "AItest/E2ETest/Req/TC/specs/bar.spec.ts")
    ).toBe(false);
  });
});
