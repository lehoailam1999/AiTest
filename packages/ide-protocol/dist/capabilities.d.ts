/**
 * Phase 2 — Capability Negotiation (Desktop ↔ Extension).
 * Additive on BridgeHealth — old extensions without capabilities still connect.
 */
export declare const IdeCapabilities: {
    readonly unit: "unit";
    readonly e2e: "e2e";
    readonly stream: "stream";
    readonly planner: "planner";
    readonly sessionReuse: "sessionReuse";
    readonly tcSync: "tcSync";
};
export type IdeCapability = (typeof IdeCapabilities)[keyof typeof IdeCapabilities] | string;
/** Caps this Extension build advertises. */
export declare const EXTENSION_CAPABILITIES: IdeCapability[];
/** Desktop requires these before IDE Unit Gen. */
export declare const DESKTOP_REQUIRED_UNIT_CAPS: IdeCapability[];
/** Desktop requires these before IDE E2E Gen (Agent CLI). */
export declare const DESKTOP_REQUIRED_E2E_CAPS: IdeCapability[];
export type CapabilityNegotiation = {
    ok: boolean;
    missing: string[];
    offered: string[];
    required: string[];
};
export declare function negotiateCapabilities(offered: readonly string[] | null | undefined, required: readonly string[]): CapabilityNegotiation;
export declare function hasCapability(offered: readonly string[] | null | undefined, cap: string): boolean;
