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
import { isTauri, readTextFile } from "../../tauri/bridge";
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
  allowDiskReresolve: boolean;
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
  allowDiskReresolve: false,
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
        allowDiskReresolve?: boolean;
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
      allowDiskReresolve: unit.allowDiskReresolve === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
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
