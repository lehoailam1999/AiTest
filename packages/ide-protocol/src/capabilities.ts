/**
 * Phase 2 — Capability Negotiation (Desktop ↔ Extension).
 * Additive on BridgeHealth — old extensions without capabilities still connect.
 */

export const IdeCapabilities = {
  unit: "unit",
  e2e: "e2e",
  stream: "stream",
  planner: "planner",
  sessionReuse: "sessionReuse",
  tcSync: "tcSync",
  /** Unit Approve via IDE Repository Intelligence (symbols/defs/refs). */
  repositoryIntelligence: "repositoryIntelligence",
  unitApproveV2: "unitApproveV2",
} as const;

export type IdeCapability =
  (typeof IdeCapabilities)[keyof typeof IdeCapabilities] | string;

/** Caps this Extension build advertises. */
export const EXTENSION_CAPABILITIES: IdeCapability[] = [
  IdeCapabilities.unit,
  IdeCapabilities.e2e,
  IdeCapabilities.stream,
  IdeCapabilities.sessionReuse,
  IdeCapabilities.tcSync,
  IdeCapabilities.repositoryIntelligence,
  IdeCapabilities.unitApproveV2,
];

/** Desktop requires these before IDE Unit Gen. */
export const DESKTOP_REQUIRED_UNIT_CAPS: IdeCapability[] = [
  IdeCapabilities.unit,
];

/** Desktop requires these before Unit Approve v2. */
export const DESKTOP_REQUIRED_UNIT_APPROVE_CAPS: IdeCapability[] = [
  IdeCapabilities.repositoryIntelligence,
  IdeCapabilities.unitApproveV2,
];

/** Desktop requires these before IDE E2E Gen (Agent CLI). */
export const DESKTOP_REQUIRED_E2E_CAPS: IdeCapability[] = [
  IdeCapabilities.e2e,
];

export type CapabilityNegotiation = {
  ok: boolean;
  missing: string[];
  offered: string[];
  required: string[];
};

export function negotiateCapabilities(
  offered: readonly string[] | null | undefined,
  required: readonly string[]
): CapabilityNegotiation {
  const list = (offered || []).map((c) => c.trim()).filter(Boolean);
  // Legacy bridges (no capabilities field): do not block — Desktop falls back to method probe.
  if (!list.length) {
    return {
      ok: true,
      missing: [],
      offered: [],
      required: [...required],
    };
  }
  const set = new Set(list);
  const missing = required.filter((r) => !set.has(r));
  return {
    ok: missing.length === 0,
    missing,
    offered: [...set],
    required: [...required],
  };
}

export function hasCapability(
  offered: readonly string[] | null | undefined,
  cap: string
): boolean {
  return (offered || []).includes(cap);
}
