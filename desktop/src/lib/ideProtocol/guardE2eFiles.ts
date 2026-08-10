/**
 * Desktop helper for Phase B — post Extension Gen through API guard-only.
 */
import { generateE2e, type E2EFileDto } from "../../api";

export async function guardE2eFilesViaApi(opts: {
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
  const res = await generateE2e.codegenGuard({
    projectId: opts.projectId,
    files: opts.files,
    featurePath: opts.featurePath,
    locatorContract: opts.locatorContract,
    executionContext: opts.executionContext,
    authMode: opts.authMode,
    useStorageState: opts.useStorageState,
    title: opts.title,
    testData: opts.testData,
  });
  return res.files || [];
}
