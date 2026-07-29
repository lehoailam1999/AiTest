import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isE2eTestCaseType,
  isUnitTestCaseType,
  resolveTestEngine,
} from "./testEngine.js";

describe("testEngine R1", () => {
  it("maps E2E synonyms", () => {
    assert.equal(resolveTestEngine("E2E"), "e2e");
    assert.equal(resolveTestEngine("Journey"), "e2e");
    assert.equal(resolveTestEngine("UI"), "e2e");
    assert.equal(isE2eTestCaseType("end-to-end"), true);
    assert.equal(isUnitTestCaseType("E2E"), false);
  });

  it("maps Unit and Functional to unit", () => {
    assert.equal(resolveTestEngine("Unit"), "unit");
    assert.equal(resolveTestEngine("Chức năng"), "unit");
    assert.equal(resolveTestEngine("Functional"), "unit");
    assert.equal(isUnitTestCaseType("Unit"), true);
    assert.equal(isUnitTestCaseType("Boundary"), true);
  });

  it("maps API", () => {
    assert.equal(resolveTestEngine("Api"), "api");
    assert.equal(resolveTestEngine("API"), "api");
    assert.equal(isUnitTestCaseType("Api"), false);
  });
});
