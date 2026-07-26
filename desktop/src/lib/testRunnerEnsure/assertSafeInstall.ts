/**
 * Allowlist install commands before sending to Tauri shell.
 * Rejects shell metacharacters outside our known patterns.
 */

const ALLOWED_PREFIXES = [
  /^npm\s+(install|i)\s+-D\s+[\w@/.\-]+(?:\s+[\w@/.\-]+)*$/i,
  /^pnpm\s+add\s+-D\s+[\w@/.\-]+(?:\s+[\w@/.\-]+)*$/i,
  /^yarn\s+add\s+-D\s+[\w@/.\-]+(?:\s+[\w@/.\-]+)*$/i,
  /^bun\s+add\s+-d\s+[\w@/.\-]+(?:\s+[\w@/.\-]+)*$/i,
  /^python\s+-m\s+pip\s+install\s+[\w.\-]+(?:\s+[\w.\-]+)*$/i,
  /^pip\s+install\s+[\w.\-]+(?:\s+[\w.\-]+)*$/i,
  /^dotnet\s+add\s+".+"\s+package\s+[\w.]+$/i,
  /^dotnet\s+add\s+".+"\s+package\s+[\w.]+\s+&&\s+dotnet\s+add\s+".+"\s+package\s+[\w.]+$/i,
  /^dotnet\s+new\s+xunit\s+-n\s+AItest\.UnitTests\s+-o\s+AItest\/UnitTest\s+--force$/i,
];

export function assertSafeInstallCommand(command: string): string {
  const cmd = command.trim().replace(/\s+/g, " ");
  if (!cmd) throw new Error("Lệnh cài đặt trống");
  if (/[;|`$<>]/.test(cmd)) {
    throw new Error("Lệnh cài đặt chứa ký tự không cho phép");
  }
  // Allow only one && for chained dotnet add
  if ((cmd.match(/&&/g) || []).length > 1) {
    throw new Error("Lệnh cài đặt quá phức tạp");
  }
  const ok = ALLOWED_PREFIXES.some((re) => re.test(cmd));
  if (!ok) {
    throw new Error(`Lệnh cài đặt không nằm trong allowlist: ${cmd}`);
  }
  return cmd;
}
