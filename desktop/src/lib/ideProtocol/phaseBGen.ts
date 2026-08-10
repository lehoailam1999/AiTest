/**
 * Phase B entry — Extension Gen stubs + mandatory API post-guard.
 * Local Cursor Agent Gen remains deferred until G1–G6 smoke is green.
 */
import type {
  CodegenE2eItem,
  CodegenProjectRulesSource,
  CodegenResultCallback,
} from "@aitest/ide-protocol";
import { getIdeRpcClientOrNull } from "../ideBridge/session";
import { guardE2eFilesViaApi } from "./guardE2eFiles";
import type { E2EFileDto } from "../../api";

export async function tryExtensionGenerateE2eBatch(params: {
  commandId: string;
  projectId: string;
  projectRoot: string;
  projectRules: string;
  projectRulesSource?: CodegenProjectRulesSource;
  items: CodegenE2eItem[];
}): Promise<CodegenResultCallback | null> {
  const client = getIdeRpcClientOrNull();
  if (!client?.isConnected) return null;
  return client.codegenGenerateE2eBatch({
    commandId: params.commandId,
    action: "GENERATE_E2E_BATCH",
    projectId: params.projectId,
    projectRoot: params.projectRoot,
    projectRules: params.projectRules,
    projectRulesSource: params.projectRulesSource ?? "none",
    items: params.items,
  });
}

/**
 * After Extension (or any draft) Gen — always run API guard-only before Apply.
 */
export async function postGuardE2eDraftFiles(opts: {
  projectId: string;
  files: E2EFileDto[];
  featurePath?: string;
  locatorContract?: string;
  executionContext?: string;
  authMode?: string;
  useStorageState?: boolean;
  title?: string;
  testData?: string;
}): Promise<E2EFileDto[]> {
  return guardE2eFilesViaApi(opts);
}
