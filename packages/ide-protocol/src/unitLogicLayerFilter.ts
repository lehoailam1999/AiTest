/**
 * Phase 2 — hard Unit primary candidate filter (portable path shapes).
 * Deny FE shells / tests / constants always.
 * Prefer Service/Handler/Application when those candidates are score-competitive.
 * Manual path:/code: markers may still override at Gen time.
 */
import { pathsMatchMarker } from "./unitPrimaryPrefer.js";
import { UNIT_RANK_POLICY } from "./unitRuleEngine.js";

function norm(pathRel: string): string {
  return (pathRel || "").replace(/\\/g, "/").toLowerCase();
}

/**
 * Shared weak FE / thin HTTP client shapes (Desktop planner + Extension Gen).
 * Combines ClientApp/pages/components + resumable/chunk upload clients.
 */
export function isWeakUnitClientPath(pathRel: string): boolean {
  const p = norm(pathRel);
  if (!p) return true;
  if (UNIT_RANK_POLICY.weakClientAppAdminRe.test(p)) return true;
  if (UNIT_RANK_POLICY.weakHttpClientRe.test(p)) return true;
  if (/\/clientapp\/|\/client-app\/|\/wwwroot\//.test(p)) return true;
  return false;
}

/** True when TC path: marker explicitly points at this file (manual override). */
export function markersPointAtPath(
  pathRel: string,
  markers?: { paths?: string[] | null } | null
): boolean {
  if (!pathRel || !markers?.paths?.length) return false;
  for (const m of markers.paths) {
    if (pathsMatchMarker(pathRel, m)) return true;
  }
  return false;
}

/**
 * Phase 2 deny for auto-primary, unless TC path: explicitly points here.
 */
export function isBlockedUnitPrimaryPath(
  pathRel: string,
  markers?: { paths?: string[] | null } | null
): boolean {
  if (markersPointAtPath(pathRel, markers)) return false;
  return isDeniedUnitPrimaryPath(pathRel);
}

/**
 * Hard deny as Unit auto-primary (Approve enrich / retrieve primary).
 * Portable shapes only — no product folder names.
 */
export function isDeniedUnitPrimaryPath(pathRel: string): boolean {
  const p = norm(pathRel);
  if (!p) return true;

  // Existing tests / suites / generated
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(p)) return true;
  if (/tests?\.cs$/.test(p) || /\.(tests?|spec)\.cs$/.test(p)) return true;
  if (/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (/\/aitest\/|\/\.ai-test\//.test(p)) return true;
  if (/\/e2e\/|\.e2e\.|\/playwright/.test(p)) return true;
  if (/\.page\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (/\/migrations?\//.test(p) || /\.designer\.cs$|\.snapshot\.cs$|modelsnapshot\.cs$/.test(p))
    return true;

  // FE / SPA shells + thin HTTP upload clients
  if (isWeakUnitClientPath(pathRel)) return true;
  if (/\.component\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (/\.(tsx|jsx|vue|html|cshtml|razor)$/.test(p)) return true;

  // Constants / pipes / FE-only helpers
  if (
    /\.(constant|constants|enum|enums|pipe|directive|interceptor|guard)\.(ts|js)$/.test(p)
  ) {
    return true;
  }
  if (/\/(constants?|enums?|pipes?|directives?|interceptors?|guards?)\//.test(p)) {
    return true;
  }

  return false;
}

/**
 * Anemic entity / POCO / DTO shapes — fine as *related*, weak as Unit *primary*
 * when the TC is about validate / reject / enable-disable behavior.
 */
export function isAnemicEntityLikePath(pathRel: string): boolean {
  const p = norm(pathRel);
  if (!p) return false;
  if (/(handler|service|validator|usecase|policy|command|query)\.(cs|ts|tsx|js)$/i.test(p)) {
    return false;
  }
  if (/\/(entities?|models?|dto|dtos|viewmodels?|pocos?)\//.test(p)) return true;
  if (/\/domain\/entities?\//.test(p)) return true;
  // Bare *Entity.cs / *Model.cs / *Dto(s).cs without handler/service stem
  const base = p.split("/").pop() || "";
  if (/\.(entity|model|dto|poco)\.(cs|ts)$/i.test(base)) return true;
  if (/entity\.cs$/i.test(base) || /model\.cs$/i.test(base)) return true;
  if (/dtos?\.(cs|ts)$/i.test(base)) return true;
  if (/(request|response|viewmodel)s?\.(cs|ts)$/i.test(base)) return true;
  return false;
}

/**
 * TC implies behavior primary (validate / reject / enable-disable / filter),
 * not “assert property on entity”.
 */
export function tcImpliesBehaviorPrimary(tcText: string): boolean {
  const t = tcText || "";
  return (
    /từ\s*chối|tu\s*choi|\breject(ed|ion)?\b|\bdeny\b|\bdenied\b/i.test(t) ||
    /\bdisable\b|\benable\b|không\s*cho\s*phép|khong\s*cho\s*phep/i.test(t) ||
    /validate|validation|kiểm\s*tra|kiem\s*tra|filter|lọc|loc\b/i.test(t) ||
    /occupied|isoccupied|đã\s*chứa|da\s*chua|ngăn\s*trống|ngan\s*trong/i.test(t) ||
    /forbidden|assert|bị\s*từ/i.test(t)
  );
}

/**
 * Preferred logic-layer shapes for Unit primary.
 */
export function isPreferredLogicLayerPath(pathRel: string): boolean {
  if (isDeniedUnitPrimaryPath(pathRel)) return false;
  if (isAnemicEntityLikePath(pathRel)) return false;
  const p = norm(pathRel);
  const base = p.split("/").pop() || p;

  if (
    /\.(service|handler|validator|usecase|use-case|policy|command|query)\./.test(p)
  ) {
    return true;
  }
  if (/(handler|service|validator|usecase|policy|command|query)\.cs$/i.test(base)) {
    return true;
  }
  if (/[a-z0-9](service|handler|validator|usecase|policy)\.[a-z0-9.]+$/i.test(base)) {
    return true;
  }
  if (/\/(commands?|queries?|handlers?|validators?|services?)\//.test(p)) {
    return true;
  }
  // Folder shapes — allow Xxx.Infrastructure/Services; Application; Domain *services* not Entities
  if (/infrastructure\/services?\//.test(p)) return true;
  if (/\/application\//.test(p)) return true;
  if (/\/domain\//.test(p) && !/\/entities?\//.test(p) && !/\/models?\//.test(p)) {
    return true;
  }

  // Segment-exact prefer shapes (avoid identity⊃entity)
  const parts = p.split(/[^a-z0-9]+/).filter(Boolean);
  const preferSeg = new Set(
    UNIT_RANK_POLICY.preferPathShapes.map((s) => s.toLowerCase().replace(/-/g, ""))
  );
  for (const part of parts) {
    const flat = part.replace(/-/g, "");
    if (preferSeg.has(flat)) return true;
  }
  return false;
}

/**
 * Deny for related expand (Phase 4): FE / tests / pipes / constants / thin upload clients.
 * Allows enum/types/DTO/interface folders that are denied as Unit *primary*.
 */
export function isDeniedUnitRelatedPath(pathRel: string): boolean {
  const p = norm(pathRel);
  if (!p) return true;

  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(p)) return true;
  if (/tests?\.cs$/.test(p) || /\.(tests?|spec)\.cs$/.test(p)) return true;
  if (/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (/\/aitest\/|\/\.ai-test\//.test(p)) return true;
  if (/\/e2e\/|\.e2e\.|\/playwright/.test(p)) return true;
  if (/\.page\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (/\/migrations?\//.test(p) || /\.designer\.cs$|\.snapshot\.cs$|modelsnapshot\.cs$/.test(p))
    return true;

  if (UNIT_RANK_POLICY.weakClientAppAdminRe.test(p)) return true;
  if (/\/clientapp\/|\/client-app\/|\/wwwroot\//.test(p)) return true;
  if (/\.component\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (/\.(tsx|jsx|vue|html|cshtml|razor)$/.test(p)) return true;
  if (UNIT_RANK_POLICY.weakHttpClientRe.test(p)) return true;

  // Pipes / constants / FE helpers — not useful related for logic Unit
  if (/\.(constant|constants|pipe|directive|interceptor|guard)\.(ts|js)$/.test(p)) {
    return true;
  }
  if (/\/(constants?|pipes?|directives?|interceptors?|guards?)\//.test(p)) {
    return true;
  }
  return false;
}

/**
 * Path-list filter: hard-deny only (no scores → cannot judge prefer competitiveness).
 */
export function filterUnitLogicLayerPaths(paths: string[]): string[] {
  return paths.filter((p) => !isDeniedUnitPrimaryPath(p));
}

/**
 * Scored-candidate filter:
 * 1) drop denied
 * 2) behavior TCs drop anemic entities when any Handler/Service remains
 * 3) if preferred are competitive with best score → keep preferred only
 * 4) else keep all non-denied (avoids weak cross-domain Handler beating Form)
 */
export function filterUnitLogicLayerCandidates<
  T extends { pathRel: string; score?: number },
>(
  cands: T[],
  opts?: {
    tcText?: string | null;
    /**
     * When TC layerHint is dto|validator: keep DTO/Validator primaries
     * (do not drop as “anemic” for behavior TCs).
     */
    allowValidationLayerPrimary?: boolean;
  }
): T[] {
  let allowed = cands.filter((c) => !isDeniedUnitPrimaryPath(c.pathRel));
  if (!allowed.length) return [];

  if (
    tcImpliesBehaviorPrimary(opts?.tcText || "") &&
    !opts?.allowValidationLayerPrimary
  ) {
    const withoutEntity = allowed.filter((c) => !isAnemicEntityLikePath(c.pathRel));
    if (withoutEntity.length) allowed = withoutEntity;
  }

  const preferred = allowed.filter((c) => isPreferredLogicLayerPath(c.pathRel));
  if (!preferred.length) return allowed;

  const maxAllowed = Math.max(...allowed.map((c) => c.score ?? 0));
  const maxPreferred = Math.max(...preferred.map((c) => c.score ?? 0));
  if (maxPreferred >= maxAllowed * 0.65 || maxPreferred + 20 >= maxAllowed) {
    return preferred;
  }
  return allowed;
}
