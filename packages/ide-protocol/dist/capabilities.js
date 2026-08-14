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
};
/** Caps this Extension build advertises. */
export const EXTENSION_CAPABILITIES = [
    IdeCapabilities.unit,
    IdeCapabilities.e2e,
    IdeCapabilities.stream,
    IdeCapabilities.sessionReuse,
    IdeCapabilities.tcSync,
];
/** Desktop requires these before IDE Unit Gen. */
export const DESKTOP_REQUIRED_UNIT_CAPS = [
    IdeCapabilities.unit,
];
export function negotiateCapabilities(offered, required) {
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
export function hasCapability(offered, cap) {
    return (offered || []).includes(cap);
}
