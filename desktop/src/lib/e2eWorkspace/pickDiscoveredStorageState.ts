/**
 * Pick a project-relative storageState path from authDiscover response.
 * Prefer defaultRole's valid file, else any role with storageStateValid.
 */
export function pickDiscoveredStorageStateRel(discovery: {
  defaultRole?: string;
  roles?: Array<{
    role: string;
    storageStateRel?: string | null;
    storageStateValid?: boolean;
  }>;
} | null | undefined): string | undefined {
  if (!discovery?.roles?.length) return undefined;
  const def = (discovery.defaultRole || "").toLowerCase();
  const preferred =
    discovery.roles.find(
      (r) =>
        r.storageStateValid &&
        r.storageStateRel &&
        r.role.toLowerCase() === def
    ) ||
    discovery.roles.find((r) => r.storageStateValid && r.storageStateRel);
  const rel = preferred?.storageStateRel?.trim().replace(/\\/g, "/");
  return rel || undefined;
}
