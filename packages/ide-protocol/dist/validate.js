import { IDE_PROTOCOL_VERSION } from "./constants.js";
export function isIdeSemanticPacket(v) {
    if (!v || typeof v !== "object")
        return false;
    const p = v;
    if (p.protocolVersion !== IDE_PROTOCOL_VERSION)
        return false;
    if (typeof p.ide !== "string")
        return false;
    if (typeof p.workspaceRoot !== "string")
        return false;
    if (typeof p.language !== "string")
        return false;
    const focus = p.focus;
    if (!focus || typeof focus !== "object")
        return false;
    const f = focus;
    return typeof f.file === "string" && typeof f.symbol === "string" && typeof f.kind === "string";
}
export function assertIdeSemanticPacket(v) {
    if (!isIdeSemanticPacket(v)) {
        throw new Error("Invalid IdeSemanticPacket");
    }
    return v;
}
export function isIdeBridgeDiscovery(v) {
    if (!v || typeof v !== "object")
        return false;
    const d = v;
    return (d.protocolVersion === IDE_PROTOCOL_VERSION &&
        typeof d.port === "number" &&
        typeof d.token === "string" &&
        typeof d.ide === "string" &&
        typeof d.startedAt === "string");
}
