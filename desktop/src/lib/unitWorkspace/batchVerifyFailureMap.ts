/**
 * Map Verify batch log failures → per-unit PASS/FAIL.
 * Supports Jest-style FAIL lines and .NET/xUnit "Failed Namespace.Class.Method".
 */
import type { UnitWorkspaceManifest } from "./types";

export type BatchVerifyRowRef = {
  testCaseId?: string | null;
  workspaceRunId?: string | null;
  title?: string | null;
};

/** Extract path / class tokens from a combined test log for per-unit attribution. */
export function extractFailedPathTokens(log: string): string[] {
  const out = new Set<string>();
  const push = (raw: string) => {
    const norm = (raw || "").replace(/\\/g, "/").trim();
    if (!norm) return;
    const base = norm.split("/").pop() || norm;
    if (base) out.add(base.toLowerCase());
    out.add(norm.toLowerCase());
  };

  const pushDotnetFqn = (fqnRaw: string) => {
    const fqn = (fqnRaw || "").trim();
    if (!fqn) return;
    // Strip theory args: Method(storageType: CLOUD)
    const bare = fqn.replace(/\([^)]*\)\s*$/, "").trim();
    if (!bare || !bare.includes(".")) return;
    push(bare);
    const parts = bare.split(".").filter(Boolean);
    if (parts.length < 2) return;
    const cls = parts[parts.length - 2];
    const method = parts[parts.length - 1];
    if (cls) {
      push(cls);
      push(`${cls}.cs`);
    }
    if (method) push(method);
  };

  // Jest / Vitest: FAIL path/to/file.test.ts
  const failLine = /^\s*FAIL\s+(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = failLine.exec(log)) !== null) {
    push(m[1] || "");
  }

  // Stack frames pointing at *.test / *.spec
  const specLine =
    /^\s*(?:at|in)\s+([^\s]+(?:\.test|\.spec)\.[a-z]+)(?::\d+)?/gim;
  while ((m = specLine.exec(log)) !== null) {
    push(m[1] || "");
  }

  // .NET VSTest summary lines:
  //   Failed Namespace.Class.Method [26 ms]
  //   Failed Namespace.Class.Method(param: value) [1 s]
  // Avoid matching "Failed!" / "Failed: 6" summary banners.
  const dotnetFailed =
    /^\s*Failed\s+((?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*(?:\([^)]*\))?)\s*(?:\[|$)/gim;
  while ((m = dotnetFailed.exec(log)) !== null) {
    pushDotnetFqn(m[1] || "");
  }

  // xUnit progressive reporter:
  //   [xUnit.net 00:00:00.16]     Namespace.Class.Method [FAIL]
  const xunitFail =
    /((?:[A-Za-z_]\w*\.)+[A-Za-z_]\w*(?:\([^)]*\))?)\s*\[FAIL\]/gim;
  while ((m = xunitFail.exec(log)) !== null) {
    pushDotnetFqn(m[1] || "");
  }

  // Stack: ... in D:\...\StorageProviderFactoryTests_d363eb05.cs:line 40
  const csInStack =
    /(?:^|\s)(?:in|at)\s+([^\s:]+\.cs)(?::(?:line\s*)?\d+)?/gim;
  while ((m = csInStack.exec(log)) !== null) {
    push(m[1] || "");
  }

  return [...out];
}

export function rowMatchesFailedTokens(
  row: BatchVerifyRowRef,
  manifest: UnitWorkspaceManifest | undefined,
  tokens: string[]
): boolean {
  if (!tokens.length) return false;
  const hay = new Set<string>();
  const add = (s?: string | null) => {
    const norm = (s || "").replace(/\\/g, "/").trim();
    if (!norm) return;
    hay.add(norm.toLowerCase());
    const base = norm.split("/").pop() || norm;
    hay.add(base.toLowerCase());
    // Class name without extension for FooTests_abc.cs
    if (base.toLowerCase().endsWith(".cs")) {
      hay.add(base.slice(0, -3).toLowerCase());
    }
  };
  add(row.testCaseId);
  add(row.workspaceRunId);
  add(row.title);
  for (const f of manifest?.files || []) {
    add(f.targetRel);
    add(f.workspaceRel);
  }
  for (const t of tokens) {
    for (const h of hay) {
      if (h.includes(t) || t.includes(h)) return true;
    }
  }
  return false;
}

/** Batch verify PASS for one row (shared by table + log units). */
export function batchVerifyPass(
  row: BatchVerifyRowRef,
  manifest: UnitWorkspaceManifest | undefined,
  failedTokens: string[],
  hasMappedFailure: boolean
): boolean {
  if (manifest?.verify?.overallPass) return true;
  if (!hasMappedFailure) return false;
  return !rowMatchesFailedTokens(row, manifest, failedTokens);
}

/**
 * Pull log lines related to a failed unit (class / .cs / method tokens).
 * Used for «Chi tiết lỗi» on batch Verify FAIL rows.
 */
export function extractUnitFailureExcerpt(
  log: string,
  row: BatchVerifyRowRef,
  manifest: UnitWorkspaceManifest | undefined,
  failedTokens: string[],
  maxChars = 6000
): string {
  if (!log.trim()) return "";
  const tokens = failedTokens.filter((t) =>
    rowMatchesFailedTokens(row, manifest, [t])
  );
  const needles =
    tokens.length > 0
      ? tokens
      : [
          row.testCaseId,
          ...(manifest?.files || []).flatMap((f) => [
            f.targetRel?.split(/[/\\]/).pop(),
            f.targetRel,
          ]),
        ]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase());

  if (!needles.length) return "";

  const lines = log.split(/\r?\n/);
  const out: string[] = [];
  const used = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const low = lines[i].toLowerCase();
    if (!needles.some((n) => n.length >= 4 && low.includes(n))) continue;
    const start = i;
    let end = Math.min(lines.length - 1, i + 14);
    // Extend through Error Message / Stack Trace blocks
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      const l = lines[j];
      if (/^\s*Failed\s+(?:[A-Za-z_]\w*\.)+/i.test(l) && j > i) break;
      if (/^\s*Failed!\s*-/i.test(l)) break;
      if (/^Results File:/i.test(l)) break;
      end = j;
      if (/^\s*Stack Trace:/i.test(l)) {
        end = Math.min(lines.length - 1, j + 18);
        break;
      }
    }
    for (let j = start; j <= end; j++) {
      if (used.has(j)) continue;
      used.add(j);
      out.push(lines[j]);
    }
    i = end;
    if (out.join("\n").length >= maxChars) break;
  }

  const text = out.join("\n").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}
