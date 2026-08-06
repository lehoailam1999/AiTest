/** Content hash for incremental re-index (hex sha-256). */

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashContent(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const dig = await globalThis.crypto.subtle.digest("SHA-256", data);
    return toHex(dig);
  }
  // Fallback (tests without subtle): FNV-1a 64-bit hex
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < data.length; i++) {
    h ^= BigInt(data[i]);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `fnv1a64_${h.toString(16)}`;
}
