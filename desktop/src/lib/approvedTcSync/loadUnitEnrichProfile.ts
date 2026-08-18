/**
 * Load portable Unit knobs from SUT `.ai-test/project.profile.json` + intent rules file.
 * No product nouns — schema only.
 */
import {
  applyProfileDomainGuards,
  parseUnitProjectIntentRules,
  type UnitDomainGuardRule,
  type UnitProjectIntentRule,
} from "@aitest/ide-protocol";
import { isTauri, readTextFile, writeTextFile } from "../../tauri/bridge";
import type { CodeAliasMap } from "../projectIntelligence/viCodeAliases";

export type UnitFieldAliasMap = Record<string, string | string[]>;

export type UnitEnrichProfileKnobs = {
  scope: "backend" | "frontend" | "any";
  minAlignment: number;
  domainGuards: UnitDomainGuardRule[];
  sutMap: Record<string, string>;
  intentRules: UnitProjectIntentRule[];
  intentRulesFile: string;
  codeAliasesFile: string;
  codeAliases?: CodeAliasMap | null;
  fieldAliases?: UnitFieldAliasMap;
};

/**
 * Flatten sutMap: supports flat `key → path` and nested
 * `module → { default: { path }, intentKey: { path } }` (optional per-SUT shape).
 */
export function flattenSutMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k?.trim()) continue;
    if (typeof v === "string" && v.trim()) {
      out[k.trim()] = v.replace(/\\/g, "/").trim();
      continue;
    }
    if (!v || typeof v !== "object") continue;
    for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
      let path = "";
      if (typeof iv === "string" && iv.trim()) {
        path = iv.replace(/\\/g, "/").trim();
      } else if (
        iv &&
        typeof iv === "object" &&
        typeof (iv as { path?: unknown }).path === "string"
      ) {
        path = String((iv as { path: string }).path)
          .replace(/\\/g, "/")
          .trim();
      }
      if (!path) continue;
      if (ik === "default") out[k.trim()] = path;
      else out[ik.trim()] = path;
    }
  }
  return out;
}

const DEFAULTS: UnitEnrichProfileKnobs = {
  scope: "backend",
  minAlignment: 50,
  domainGuards: [],
  sutMap: {},
  intentRules: [],
  intentRulesFile: ".ai-test/unit-intent-rules.json",
  codeAliasesFile: ".ai-test/code-aliases.json",
  codeAliases: null,
  fieldAliases: {},
};

export async function loadUnitEnrichProfileKnobs(
  projectRoot: string
): Promise<UnitEnrichProfileKnobs> {
  if (!projectRoot?.trim()) return { ...DEFAULTS };
  try {
    const raw = await readTextFile(projectRoot, ".ai-test/project.profile.json");
    const j = JSON.parse(raw) as {
      unit?: {
        scope?: string;
        minAlignment?: number;
        domainGuards?: UnitDomainGuardRule[];
        sutMap?: Record<string, string>;
        intentRulesFile?: string;
        codeAliasesFile?: string;
      };
    };
    const unit = j?.unit || {};
    const scopeRaw = (unit.scope || "backend").toLowerCase();
    const scope: "backend" | "frontend" | "any" =
      scopeRaw === "frontend" || scopeRaw === "any" || scopeRaw === "backend"
        ? scopeRaw
        : "backend";
    const intentRulesFile =
      unit.intentRulesFile || DEFAULTS.intentRulesFile;
    const codeAliasesFile =
      unit.codeAliasesFile || DEFAULTS.codeAliasesFile;
    let intentRules: UnitProjectIntentRule[] = [];
    try {
      const irRaw = await readTextFile(
        projectRoot,
        intentRulesFile.replace(/\\/g, "/").replace(/^\.\//, "")
      );
      intentRules = parseUnitProjectIntentRules(JSON.parse(irRaw));
    } catch {
      /* optional */
    }
    let codeAliases: CodeAliasMap | null = null;
    let fieldAliases: UnitFieldAliasMap = {};
    try {
      const aliasesRaw = await readTextFile(
        projectRoot,
        codeAliasesFile.replace(/\\/g, "/").replace(/^\.\//, "")
      );
      const parsed = JSON.parse(aliasesRaw) as Record<string, unknown>;
      const domainAliases: CodeAliasMap = {};
      for (const [key, value] of Object.entries(parsed || {})) {
        if (key === "fields" || !Array.isArray(value)) continue;
        const values = value.map((v) => String(v || "").trim()).filter(Boolean);
        if (values.length) domainAliases[key] = values;
      }
      codeAliases = Object.keys(domainAliases).length ? domainAliases : null;
      const fields = parsed?.fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) {
        fieldAliases = Object.fromEntries(
          Object.entries(fields as Record<string, unknown>)
            .map(([key, value]) => {
              if (Array.isArray(value)) {
                const values = value
                  .map((v) => String(v || "").trim())
                  .filter(Boolean);
                return values.length ? [key, values] : null;
              }
              const text = String(value || "").trim();
              return text ? [key, text] : null;
            })
            .filter((entry): entry is [string, string | string[]] => Boolean(entry))
        );
      }
    } catch {
      /* optional */
    }
    return {
      scope,
      minAlignment:
        typeof unit.minAlignment === "number" && Number.isFinite(unit.minAlignment)
          ? unit.minAlignment
          : 50,
      domainGuards: Array.isArray(unit.domainGuards) ? unit.domainGuards : [],
      sutMap: flattenSutMap(unit.sutMap),
      intentRules,
      intentRulesFile,
      codeAliasesFile,
      codeAliases,
      fieldAliases,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Merge IDE-verified label→property bindings into a code-aliases payload.
 * Existing entries win so a later wrong pick cannot overwrite a known mapping.
 */
export function applyLearnedFieldAliases(
  parsed: Record<string, unknown> | null | undefined,
  bindings: readonly { label: string; property: string }[]
): { next: Record<string, unknown>; added: number } {
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const fields =
    source.fields && typeof source.fields === "object" && !Array.isArray(source.fields)
      ? { ...(source.fields as Record<string, unknown>) }
      : {};
  let added = 0;
  for (const binding of bindings) {
    const label = binding.label.trim();
    const property = binding.property.trim();
    if (!label || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(property)) continue;
    const existing = fields[label];
    if (typeof existing === "string" && existing.trim()) continue;
    if (Array.isArray(existing) && existing.length) continue;
    fields[label] = property;
    added += 1;
  }
  return { next: { ...source, fields }, added };
}

/**
 * Persist IDE-verified field bindings into the project alias file so later
 * Approve runs can bind without waiting for CLI, and without hand-editing.
 */
export async function mergeLearnedFieldAliases(
  projectRoot: string,
  bindings: readonly { label: string; property: string }[]
): Promise<number> {
  if (!projectRoot?.trim() || !bindings.length || !isTauri()) return 0;
  const knobs = await loadUnitEnrichProfileKnobs(projectRoot);
  const rel = knobs.codeAliasesFile.replace(/\\/g, "/").replace(/^\.\//, "");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(await readTextFile(projectRoot, rel)) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const { next, added } = applyLearnedFieldAliases(parsed, bindings);
  if (!added) return 0;
  await writeTextFile(projectRoot, rel, `${JSON.stringify(next, null, 2)}\n`);
  return added;
}

/** Filter seed candidates through profile domainGuards (module cue). */
export function filterCandidatesByDomainGuards<T extends { pathRel: string }>(
  candidates: T[],
  moduleText: string,
  rules: UnitDomainGuardRule[] | null | undefined
): T[] {
  if (!rules?.length || !candidates.length) return candidates;
  return candidates.filter((c) => {
    const r = applyProfileDomainGuards({
      moduleText,
      primaryPath: c.pathRel,
      rules,
    });
    return r.pass;
  });
}

export { isTauri };
