/**
 * Verify failure wrapping — do not mask taxonomy / grounding errors.
 */

function hasExecutionGateArtifacts(text: string): boolean {
  const t = (text || "").toLowerCase();
  const hasStep = /step|test\.step|bước/.test(t);
  const hasLocator = /locator|getby|data-testid|data-cy|selector/.test(t);
  const hasEndpoint = /waitforresponse|endpoint|network|api|response/.test(t);
  const hasTrace = /trace|screenshot|video|artifact/.test(t);
  return hasStep && hasLocator && hasEndpoint && hasTrace;
}

function isStandardE2eFailure(text: string): boolean {
  return /ContextMissing|PreconditionFailed|LocatorNotFound|BusinessAssertionFailed|E2E_GROUNDING|Thiếu Context/i.test(
    text || ""
  );
}

/**
 * Only for opaque Playwright fails missing log contract.
 * Do NOT wrap taxonomy errors (e.g. ContextMissing E2E_STORAGE_*) — that confuses Gen-vs-Verify.
 */
export function enforceExecutionGateFailure(err: string | undefined): string {
  const msg = (err || "Verify failed").trim();
  if (isStandardE2eFailure(msg)) return msg;
  if (hasExecutionGateArtifacts(msg)) return msg;
  return (
    "ExecutionGateFailed: missing artifact contract (step fail + locator tried + endpoint wait + trace/screenshot). " +
    msg
  );
}
