import { IDE_PROTOCOL_VERSION } from "./constants.js";
import type { IdeSemanticPacket, IdeBridgeDiscovery } from "./types.js";

export function isIdeSemanticPacket(v: unknown): v is IdeSemanticPacket {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if (p.protocolVersion !== IDE_PROTOCOL_VERSION) return false;
  if (typeof p.ide !== "string") return false;
  if (typeof p.workspaceRoot !== "string") return false;
  if (typeof p.language !== "string") return false;
  const focus = p.focus;
  if (!focus || typeof focus !== "object") return false;
  const f = focus as Record<string, unknown>;
  return typeof f.file === "string" && typeof f.symbol === "string" && typeof f.kind === "string";
}

export function assertIdeSemanticPacket(v: unknown): IdeSemanticPacket {
  if (!isIdeSemanticPacket(v)) {
    throw new Error("Invalid IdeSemanticPacket");
  }
  return v;
}

export function isIdeBridgeDiscovery(v: unknown): v is IdeBridgeDiscovery {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    d.protocolVersion === IDE_PROTOCOL_VERSION &&
    typeof d.port === "number" &&
    typeof d.token === "string" &&
    typeof d.ide === "string" &&
    typeof d.startedAt === "string"
  );
}
