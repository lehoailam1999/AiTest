/**
 * Content-dedup for Unit workspace — skip identical scaffold/apply writes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isIdenticalContent } from "./contentDedup.js";
import {
  buildAitestJestConfigJs,
  buildAitestJestTsconfig,
} from "./ensureAitestJestTsconfig.js";

describe("contentDedup", () => {
  it("detects identical scaffold bytes", () => {
    const jest = buildAitestJestConfigJs();
    assert.equal(isIdenticalContent(jest, jest), true);
    assert.equal(isIdenticalContent(null, jest), false);
    assert.equal(isIdenticalContent(jest, jest + "\n"), false);
  });

  it("tsconfig builder is stable for same typeRoots", () => {
    const a = buildAitestJestTsconfig(["D:/proj/node_modules/@types"]);
    const b = buildAitestJestTsconfig(["D:/proj/node_modules/@types"]);
    assert.equal(isIdenticalContent(a, b), true);
  });
});
