import { createHash } from "node:crypto";
import type { Sha256Hex } from "@aitest/ide-protocol";

export function sha256(value: string | Uint8Array): Sha256Hex {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function hashParts(parts: readonly unknown[]): Sha256Hex {
  return sha256(stableJson(parts));
}
