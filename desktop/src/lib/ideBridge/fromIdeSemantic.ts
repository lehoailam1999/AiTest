/**
 * P2/P3 bridge — IdeSemanticPacket → AITestContextPacket via Context Builder.
 */
export {
  buildContextPacketFromIde,
  type BuildFromIdeInput,
  type BuildFromIdeResult,
} from "../projectIntelligence/ideContextBuilder";

import type { IdeSemanticPacket } from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { buildContextPacketFromIde } from "../projectIntelligence/ideContextBuilder";

/** Convenience wrapper used by GenerateUnitPage (packet key = IdeSemanticPacket). */
export async function contextPacketFromIdeSemantic(input: {
  packet: IdeSemanticPacket;
  testCase?: Pick<TestCase, "id" | "module" | "title"> | null;
  projectId?: string;
  framework?: string;
  purpose?: "generate-unit" | "generate-tc";
  testKind?: "unit" | "api" | "integration";
  readFile?: (pathRel: string) => Promise<string>;
}) {
  return buildContextPacketFromIde({
    idePacket: input.packet,
    testCase: input.testCase,
    projectId: input.projectId,
    framework: input.framework,
    purpose: input.purpose,
    testKind: input.testKind,
    readFile: input.readFile,
  });
}

export type FromIdeSemanticInput = Parameters<typeof contextPacketFromIdeSemantic>[0];

/** Confidence high enough to skip file combobox on happy path */
export function ideFocusReadyForGenerate(
  confidence?: string | null,
  hasFocus?: boolean
): boolean {
  if (!hasFocus) return false;
  const c = (confidence || "medium").toLowerCase();
  return c === "high" || c === "medium";
}
