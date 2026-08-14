import type { BridgeStatus, Confidence, IdeKind } from "./constants.js";

export type { BridgeStatus, Confidence, IdeKind };

export type TextRange = {
  /** 0-based line (inclusive) */
  start: number;
  /** 0-based line (exclusive or inclusive — treat as end line) */
  end: number;
  startCharacter?: number;
  endCharacter?: number;
};

export type SymbolKind =
  | "file"
  | "class"
  | "interface"
  | "method"
  | "function"
  | "property"
  | "constructor"
  | "module"
  | "unknown";

export type SymbolInfo = {
  id?: string;
  name: string;
  kind: SymbolKind;
  file: string;
  range?: TextRange;
  containerName?: string;
  detail?: string;
};

export type CtorParam = {
  name: string;
  type: string;
};

export type ConstructorInfo = {
  params: CtorParam[];
  snippet?: string;
};

export type DependencySnippet = {
  path: string;
  role: "constructor" | "import" | "reference" | "implementation" | "overview";
  snippet: string;
  symbol?: string;
};

export type SymbolRef = {
  file: string;
  range?: TextRange;
  name?: string;
};

export type CallHierarchy = {
  callees: SymbolRef[];
  callers: SymbolRef[];
};

/**
 * Semantic context from IDE Plugin → Desktop Context Builder.
 * Plugin trims snippets; never send whole repo.
 */
export type IdeSemanticPacket = {
  protocolVersion: 1;
  ide: IdeKind;
  workspaceRoot: string;
  language: string;
  frameworkHints?: string[];
  focus: {
    file: string;
    symbol: string;
    kind: SymbolKind;
    method?: string;
    range?: TextRange;
  };
  signatures?: string[];
  constructors?: ConstructorInfo[];
  imports?: string[];
  dependencies?: DependencySnippet[];
  references?: SymbolRef[];
  implementations?: SymbolRef[];
  callHierarchy?: CallHierarchy;
  /** Optional focus file body (truncated) for Prompt Builder */
  focusSnippet?: string;
  diagnostics?: {
    gaps?: string[];
    confidence?: Confidence;
  };
};

/** Discovery file written by Plugin for Desktop to find the bridge */
export type IdeBridgeDiscovery = {
  protocolVersion: 1;
  port: number;
  token: string;
  ide: IdeKind;
  /** ISO timestamp when bridge started */
  startedAt: string;
  /** Optional human workspace label */
  workspaceRoot?: string;
  /** ws path, default / */
  path?: string;
};

export type BridgeHealth = {
  status: BridgeStatus;
  ide: IdeKind;
  protocolVersion: number;
  workspaceRoot?: string;
  focus?: IdeSemanticPacket["focus"];
  /** P10+ — methods this bridge implements (Desktop can detect stale extension) */
  supportedMethods?: string[];
  /** Phase 2 — capability negotiation (unit, e2e, sessionReuse, …) */
  capabilities?: string[];
  /** Extension package version when known */
  extensionVersion?: string;
};
