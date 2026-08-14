/**
 * Phase B entry — Extension Gen (Unit + E2E via Agent CLI).
 * Desktop fail-closed (no silent API fallback). E2E still runs API post-guard.
 */
import { UNIT_GEN_LIMITS } from "@aitest/ide-protocol";
import type {
  CodegenE2eItem,
  CodegenProjectRulesSource,
  CodegenResultCallback,
  CodegenUnitItem,
} from "@aitest/ide-protocol";
import type { E2EFileDto } from "../../api";
import { getIdeRpcClientOrNull } from "../ideBridge/session";
import {
  newCodegenCommandId,
  rememberCodegenResult,
  subscribeCodegenNotifications,
  type CodegenSessionHandlers,
} from "./codegenCommands";
import { useCodegenUiStore } from "./codegenUiStore";
import { guardE2eFilesViaApi } from "./guardE2eFiles";

function isTransportError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /websocket|ws\b|econnreset|econnrefused|disconnect|not connected|timed out|timeout|socket/.test(
    msg
  );
}

/**
 * E2E Gen on Extension (local AI CLI in SUT workspace).
 * Returns null when IDE offline. Caller must fail-closed (no silent API fallback).
 */
export async function tryExtensionGenerateE2eBatch(opts: {
  projectId: string;
  projectRoot: string;
  projectRules?: string;
  projectRulesSource?: CodegenProjectRulesSource;
  items: CodegenE2eItem[];
  handlers?: CodegenSessionHandlers;
  transportRetryMax?: number;
  sessionId?: string | null;
}): Promise<CodegenResultCallback | null> {
  const client = getIdeRpcClientOrNull();
  if (!client?.isConnected) return null;
  if (!opts.items.length) return null;

  const { assertIdeE2eCapabilities, ensureUnitGenSession } = await import(
    "./capabilitySession"
  );
  const { useIdeBridgeSession } = await import("../ideBridge/session");
  const caps = useIdeBridgeSession.getState().capabilities;
  const neg = assertIdeE2eCapabilities(caps);
  if (!neg.ok) {
    throw new Error(
      `IDE thiếu capability: ${neg.missing.join(", ")}. Cập nhật / Reload extension AITest.`
    );
  }

  let sessionId = opts.sessionId ?? null;
  if (!sessionId) {
    sessionId = await ensureUnitGenSession(opts.projectRoot, "e2e");
  }

  const maxRetry = opts.transportRetryMax ?? UNIT_GEN_LIMITS.transportRetryMax;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const commandId = newCodegenCommandId("e2e-gen");
    const handlers: CodegenSessionHandlers = {
      onProgress: (p) => {
        const msg = p.message || p.phase || "";
        useCodegenUiStore.getState().setProgress(msg);
        opts.handlers?.onProgress?.(p);
      },
      onResult: (r) => {
        rememberCodegenResult(r);
        useCodegenUiStore.getState().setFromResult(r);
        opts.handlers?.onResult?.(r);
      },
    };
    const unsub = subscribeCodegenNotifications(commandId, handlers);
    try {
      const live = getIdeRpcClientOrNull();
      if (!live?.isConnected) {
        throw new Error("IDE not connected");
      }
      const result = await live.codegenGenerateE2eBatch({
        commandId,
        action: "GENERATE_E2E_BATCH",
        projectId: opts.projectId,
        projectRoot: opts.projectRoot,
        projectRules: opts.projectRules ?? "",
        projectRulesSource: opts.projectRulesSource ?? "e2e-conventions",
        items: opts.items,
        ...(sessionId ? { sessionId } : {}),
      });
      rememberCodegenResult(result);
      useCodegenUiStore.getState().setFromResult(result);
      return result;
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetry && isTransportError(e)) continue;
      throw e;
    } finally {
      unsub();
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

/**
 * Phase B.1 — Unit Gen on Extension (local AI CLI in source workspace).
 * Returns null when IDE offline. Caller must fail-closed (no silent API fallback).
 * Retries once on transport errors only.
 */
export async function tryExtensionGenerateUnitBatch(opts: {
  projectId: string;
  projectRoot: string;
  projectRules?: string;
  projectRulesSource?: CodegenProjectRulesSource;
  packagePrefix?: string;
  items: CodegenUnitItem[];
  handlers?: CodegenSessionHandlers;
  /** Override transport retry count (default UNIT_GEN_LIMITS.transportRetryMax) */
  transportRetryMax?: number;
  /** Phase 2 — reuse open CLI session */
  sessionId?: string | null;
  /** Project VI→code aliases for Extension SUT resolve */
  codeAliases?: Record<string, string[]> | null;
}): Promise<CodegenResultCallback | null> {
  const client = getIdeRpcClientOrNull();
  if (!client?.isConnected) return null;
  if (!opts.items.length) return null;

  const { assertIdeUnitCapabilities, ensureUnitGenSession } = await import(
    "./capabilitySession"
  );
  const { useIdeBridgeSession } = await import("../ideBridge/session");
  const caps = useIdeBridgeSession.getState().capabilities;
  const neg = assertIdeUnitCapabilities(caps);
  if (!neg.ok) {
    throw new Error(
      `IDE thiếu capability: ${neg.missing.join(", ")}. Cập nhật / Reload extension AITest.`
    );
  }

  let sessionId = opts.sessionId ?? null;
  if (!sessionId) {
    sessionId = await ensureUnitGenSession(opts.projectRoot);
  }

  const maxRetry = opts.transportRetryMax ?? UNIT_GEN_LIMITS.transportRetryMax;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const commandId = newCodegenCommandId("unit-gen");
    const handlers: CodegenSessionHandlers = {
      onProgress: (p) => {
        const msg = p.message || p.phase || "";
        useCodegenUiStore.getState().setProgress(msg);
        opts.handlers?.onProgress?.(p);
      },
      onResult: (r) => {
        rememberCodegenResult(r);
        useCodegenUiStore.getState().setFromResult(r);
        opts.handlers?.onResult?.(r);
      },
    };
    const unsub = subscribeCodegenNotifications(commandId, handlers);
    try {
      const live = getIdeRpcClientOrNull();
      if (!live?.isConnected) {
        throw new Error("IDE not connected");
      }
      const result = await live.codegenGenerateUnitBatch({
        commandId,
        action: "GENERATE_UNIT_BATCH",
        projectId: opts.projectId,
        projectRoot: opts.projectRoot,
        packagePrefix: opts.packagePrefix,
        projectRules: opts.projectRules ?? "",
        projectRulesSource: opts.projectRulesSource ?? "unit-conventions",
        items: opts.items,
        ...(sessionId ? { sessionId } : {}),
        ...(opts.codeAliases ? { codeAliases: opts.codeAliases } : {}),
      });
      rememberCodegenResult(result);
      useCodegenUiStore.getState().setFromResult(result);
      return result;
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetry && isTransportError(e)) continue;
      throw e;
    } finally {
      unsub();
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

/** Map Desktop cancel → Extension `aitest/codegen.cancel`. */
export async function cancelExtensionCodegen(commandId: string): Promise<boolean> {
  const client = getIdeRpcClientOrNull();
  if (!client?.isConnected || !commandId) return false;
  const res = await client.codegenCancel({ commandId });
  return Boolean(res?.ok);
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
