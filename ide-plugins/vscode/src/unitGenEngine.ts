/**
 * Pluggable Unit Gen engine — Extension Gen Owner.
 * Desktop only speaks protocol; swap engine without touching Desktop.
 */
import { UNIT_GEN_LIMITS } from "@aitest/ide-protocol";
import type { CodegenFileDto, CodegenUnitItem } from "@aitest/ide-protocol";

export type UnitGenEngineCtx = {
  workspaceRoot: string;
  conventions: string;
  projectRules: string;
  tcMd: string;
  tcMdPath: string;
  primaryPath: string;
  source: string;
  related?: string;
  suggestedPath: string;
  commandId: string;
  alignmentScore?: number;
  candidatesTop3?: Array<{ path: string; score?: number; reason?: string }>;
  onProgress?: (msg: string) => void;
  isCancelled?: () => boolean;
  /** Phase 2 — session-bound runner (cached agent binary / cwd) */
  runPrompt?: (
    prompt: string,
    timeoutMs: number,
    onLine?: (s: string) => void
  ) => Promise<string>;
};

export type UnitGenEngineResult = {
  files: CodegenFileDto[];
  sourceFileName: string;
  log?: string;
  truncated?: boolean;
  metrics?: import("@aitest/ide-protocol").UnitGenPhaseMetrics;
};

export interface UnitGenEngine {
  readonly name: string;
  generate(item: CodegenUnitItem, ctx: UnitGenEngineCtx): Promise<UnitGenEngineResult>;
}

export { UNIT_GEN_LIMITS };
