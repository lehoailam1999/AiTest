import type { AITestContextPacket } from "./contextPacket/types";
import { buildContextPacket } from "./projectIntelligence/contextBuilder";
import { sourceExtensionsForLanguage } from "./stackHints";
import { isTauri, listSourceFiles } from "../tauri/bridge";

export async function buildTcJobContextPacket(input: {
  projectRoot: string;
  projectId: string;
  language?: string | null;
  framework?: string | null;
}): Promise<AITestContextPacket | null> {
  if (!isTauri()) return null;
  const exts = sourceExtensionsForLanguage(input.language);
  const paths = await listSourceFiles(input.projectRoot, exts);
  if (!paths.length) return null;

  return buildContextPacket({
    purpose: "generate-tc",
    projectRoot: input.projectRoot,
    language: input.language || "auto",
    framework: input.framework || undefined,
    projectId: input.projectId,
    allSourcePaths: paths,
  });
}
