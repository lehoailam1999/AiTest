export const CONTEXT_PACKET_VERSION = 1 as const;

export type ContextPacketPurpose = "generate-unit" | "generate-tc";

/** primary = SUT; dependency = mock/import; overview = module scan; test-sample = style reference */
export type ContextPacketFileRole = "primary" | "dependency" | "overview" | "test-sample";

export type ContextPacketFile = {
  pathRel: string;
  role: ContextPacketFileRole;
  language?: string;
  content: string;
  /** Why this file is in the packet (Prompt Builder) */
  why?: string;
};

export type TestingStackHints = {
  testingFramework?: string;
  mockFramework?: string;
  assertionLibrary?: string;
  /** package.json / existing tests / language adapter */
  detectedFrom?: string[];
  confidence?: "high" | "medium" | "low";
};

export type SourceUnderTestHints = {
  pathRel?: string;
  symbol?: string;
  methods?: string[];
  constructorDeps?: string[];
  asyncMethods?: string[];
  externalCalls?: string[];
};

export type UnitStrategyHints = {
  whatToTest?: string;
  whatToMock?: string[];
  whatNotToMock?: string[];
  forbidden?: string[];
};

export type AITestContextPacket = {
  packetVersion: typeof CONTEXT_PACKET_VERSION;
  purpose: ContextPacketPurpose;
  meta: {
    language?: string;
    framework?: string;
    projectId?: string;
    testCaseId?: string;
    runId?: string;
    /** Business module (= TC.module) — AItest/UnitTest/{Module}/ */
    module?: string;
    testKind?: "unit" | "api" | "integration";
  };
  /** @deprecated prefer testingStack — kept for older clients */
  conventions?: {
    testFramework?: string;
    testFilePattern?: string;
    mockFramework?: string;
    assertionLibrary?: string;
  };
  testingStack?: TestingStackHints;
  sourceUnderTest?: SourceUnderTestHints;
  unitStrategy?: UnitStrategyHints;
  files: ContextPacketFile[];
  diagnostics: {
    truncated: string[];
    omittedPaths: string[];
    seedReason?: string;
    /** Top path ứng viên (không kèm content) */
    seedCandidates?: { pathRel: string; score: number; reason: string }[];
    /** Path được nhắc trong nội dung TC */
    mentionedPaths?: string[];
    moduleRelatedCount?: number;
    /** Missing interfaces / unresolved imports */
    gaps?: string[];
  };
};
