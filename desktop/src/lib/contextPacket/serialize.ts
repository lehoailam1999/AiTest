import type { AITestContextPacket, ContextPacketFile } from "./types";

/** Payload gửi Backend — không persist lâu trên server. */
export function packetForApi(packet: AITestContextPacket): AITestContextPacket {
  return packet;
}

export function primaryFile(packet: AITestContextPacket): ContextPacketFile | undefined {
  return packet.files.find((f) => f.role === "primary") ?? packet.files[0];
}

export function dependencyFiles(packet: AITestContextPacket): ContextPacketFile[] {
  return packet.files.filter((f) => f.role === "dependency");
}

export function testSampleFiles(packet: AITestContextPacket): ContextPacketFile[] {
  return packet.files.filter((f) => f.role === "test-sample");
}

export function legacyRelatedSources(packet: AITestContextPacket) {
  return dependencyFiles(packet).map((f) => ({
    path: f.pathRel,
    content: f.content,
    role: f.role,
    why: f.why,
  }));
}
