import type { Sha256Hex } from "@aitest/ide-protocol";

/**
 * SHA-256 for Desktop. Tests/Node use node:crypto; the Tauri renderer falls
 * back to Web Crypto because browser WebViews do not expose Node built-ins.
 */
export async function sha256(value: string | Uint8Array): Promise<Sha256Hex> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;

  if (typeof window === "undefined") {
    const { createHash } = await import("node:crypto");
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }

  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `sha256:${hex}`;
}
