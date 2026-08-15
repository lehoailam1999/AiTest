import type { IdeBridgeDiscovery } from "@aitest/ide-protocol";

/** Milliseconds from discovery.startedAt; 0 if missing/invalid. */
export function discoveryStartedAtMs(
  discovery: Pick<IdeBridgeDiscovery, "startedAt"> | { startedAt?: string | null }
): number {
  const t = Date.parse(String(discovery.startedAt || ""));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Newest bridge first (by startedAt). Same timestamp → higher port as weak tie-break.
 */
export function sortIdeDiscoveriesByNewest<
  T extends Pick<IdeBridgeDiscovery, "startedAt" | "port">,
>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const byTime = discoveryStartedAtMs(b) - discoveryStartedAtMs(a);
    if (byTime !== 0) return byTime;
    return (b.port || 0) - (a.port || 0);
  });
}
