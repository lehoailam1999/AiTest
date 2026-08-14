/**
 * Phase 2 — capability negotiation + session id helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DESKTOP_REQUIRED_E2E_CAPS,
  DESKTOP_REQUIRED_UNIT_CAPS,
  EXTENSION_CAPABILITIES,
  IdeCapabilities,
  hasCapability,
  negotiateCapabilities,
} from "./capabilities.js";

describe("capability negotiation", () => {
  it("passes when extension advertises unit", () => {
    const n = negotiateCapabilities(EXTENSION_CAPABILITIES, DESKTOP_REQUIRED_UNIT_CAPS);
    assert.equal(n.ok, true);
    assert.equal(n.missing.length, 0);
    assert.ok(hasCapability(n.offered, IdeCapabilities.sessionReuse));
  });

  it("passes when extension advertises e2e for E2E gen", () => {
    const n = negotiateCapabilities(EXTENSION_CAPABILITIES, DESKTOP_REQUIRED_E2E_CAPS);
    assert.equal(n.ok, true);
  });

  it("fails when unit missing from non-empty offer", () => {
    const n = negotiateCapabilities(["e2e", "stream"], DESKTOP_REQUIRED_UNIT_CAPS);
    assert.equal(n.ok, false);
    assert.deepEqual(n.missing, ["unit"]);
  });

  it("legacy empty capabilities does not block", () => {
    const n = negotiateCapabilities([], DESKTOP_REQUIRED_UNIT_CAPS);
    assert.equal(n.ok, true);
    const n2 = negotiateCapabilities(undefined, DESKTOP_REQUIRED_UNIT_CAPS);
    assert.equal(n2.ok, true);
  });
});
