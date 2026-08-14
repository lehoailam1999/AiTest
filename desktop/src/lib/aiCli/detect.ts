import { knownLocationCandidates } from "./knownLocations";
import { autoDetectCliIds, getAiCliSpec } from "./registry";
import type {
  AiCliDetectResult,
  AiCliDetectedBy,
  AiCliId,
  AiCliStatus,
  DetectAiCliOpts,
} from "./types";
import { platformToOs } from "./types";

const VERSION_MAX = 120;

function iso(now: () => Date): string {
  return now().toISOString();
}

function trimVersion(stdout: string, stderr: string): string | null {
  const raw = (stdout || stderr).trim();
  if (!raw) return null;
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  return line.length > VERSION_MAX ? line.slice(0, VERSION_MAX) : line;
}

function emptyResult(
  id: AiCliId,
  name: string,
  os: ReturnType<typeof platformToOs>,
  now: () => Date,
  status: AiCliStatus,
  message: string | null
): AiCliDetectResult {
  return {
    provider: id,
    name,
    executablePath: null,
    version: null,
    detectedBy: null,
    os,
    status,
    lastCheckedAt: iso(now),
    message,
  };
}

async function validateExecutable(
  executablePath: string,
  detectedBy: AiCliDetectedBy,
  id: AiCliId,
  name: string,
  os: ReturnType<typeof platformToOs>,
  opts: DetectAiCliOpts
): Promise<AiCliDetectResult> {
  const now = opts.now ?? (() => new Date());
  const exists = await opts.probe.isFile(executablePath);
  if (!exists) {
    return {
      provider: id,
      name,
      executablePath,
      version: null,
      detectedBy,
      os,
      status: "INVALID",
      lastCheckedAt: iso(now),
      message: "CLI path is not a file.",
    };
  }

  if (opts.skipVersion) {
    return {
      provider: id,
      name,
      executablePath,
      version: null,
      detectedBy,
      os,
      status: "FOUND",
      lastCheckedAt: iso(now),
      message: null,
    };
  }

  const spec = getAiCliSpec(id);
  const args = spec?.versionArgs ?? ["--version"];
  let out;
  try {
    out = await opts.probe.runVersion(executablePath, args);
  } catch (e) {
    return {
      provider: id,
      name,
      executablePath,
      version: null,
      detectedBy,
      os,
      status: "ERROR",
      lastCheckedAt: iso(now),
      message: e instanceof Error ? e.message : "Version check failed.",
    };
  }

  if (out.error && out.exitCode === -1) {
    return {
      provider: id,
      name,
      executablePath,
      version: null,
      detectedBy,
      os,
      status: "ERROR",
      lastCheckedAt: iso(now),
      message: out.error,
    };
  }

  if (out.exitCode !== 0) {
    return {
      provider: id,
      name,
      executablePath,
      version: trimVersion(out.stdout, out.stderr),
      detectedBy,
      os,
      status: "INVALID",
      lastCheckedAt: iso(now),
      message: `Version command exited ${out.exitCode}.`,
    };
  }

  return {
    provider: id,
    name,
    executablePath,
    version: trimVersion(out.stdout, out.stderr),
    detectedBy,
    os,
    status: "READY",
    lastCheckedAt: iso(now),
    message: null,
  };
}

/**
 * Resolve one vendor: manual/env → PATH → known locations → NOT_FOUND.
 * Does not spawn generation. Version check only.
 */
export async function detectAiCli(
  id: AiCliId,
  opts: DetectAiCliOpts
): Promise<AiCliDetectResult> {
  const platform = opts.platform ?? (typeof process !== "undefined" ? process.platform : "linux");
  const os = platformToOs(platform);
  const env = opts.env ?? {};
  const now = opts.now ?? (() => new Date());
  const spec = getAiCliSpec(id);
  const name = spec?.name ?? id;

  const tryPath = async (
    abs: string,
    detectedBy: AiCliDetectedBy
  ): Promise<AiCliDetectResult | null> => {
    const trimmed = abs.trim();
    if (!trimmed) return null;
    return validateExecutable(trimmed, detectedBy, id, name, os, { ...opts, now });
  };

  const manual = (opts.manualPath || "").trim();
  if (manual) {
    return (await tryPath(manual, "manual"))!;
  }

  if (spec) {
    for (const key of spec.envPathKeys) {
      const v = (env[key] || "").trim();
      if (v) {
        const r = await tryPath(v, "env");
        if (r && r.status !== "INVALID") return r;
        if (r?.status === "INVALID") return r;
      }
    }
  }

  if (spec) {
    const names =
      platform === "win32"
        ? spec.commandCandidates
        : spec.commandCandidates.filter((n) => !/\.(exe|cmd|bat|ps1)$/i.test(n));
    for (const cmdName of names) {
      const found = await opts.probe.which(cmdName);
      if (found && found.trim()) {
        const r = await tryPath(found.trim(), "PATH");
        if (r && (r.status === "READY" || r.status === "FOUND")) return r;
        if (r?.status === "INVALID" && r.message === "CLI path is not a file.") continue;
        if (r && r.status !== "NOT_FOUND") return r;
      }
    }
  }

  for (const loc of knownLocationCandidates(id, os, env)) {
    const exists = await opts.probe.isFile(loc);
    if (!exists) continue;
    const r = await tryPath(loc, "known-location");
    if (r) return r;
  }

  if (id === "custom-script") {
    return emptyResult(
      id,
      name,
      os,
      now,
      "NOT_FOUND",
      "Custom script requires a manual executable path."
    );
  }

  return emptyResult(id, name, os, now, "NOT_FOUND", `${name} was not found on this machine.`);
}

export async function detectSupportedAiClis(
  opts: Omit<DetectAiCliOpts, "manualPath"> & {
    manualPaths?: Partial<Record<AiCliId, string | null>>;
  }
): Promise<AiCliDetectResult[]> {
  const ids = autoDetectCliIds();
  const out: AiCliDetectResult[] = [];
  for (const id of ids) {
    out.push(
      await detectAiCli(id, {
        ...opts,
        manualPath: opts.manualPaths?.[id],
      })
    );
  }
  return out;
}
