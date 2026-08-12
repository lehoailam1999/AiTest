/**
 * Derive WHO auth signals from Approved TC (precondition/testData) for codegen + env.
 * Does not invent roles — only echoes explicit markers, or optional project/Analysis fallbacks.
 */

export type AuthContextFromTc = {
  executionContext: string;
  role?: string;
  /** All actors from ``roles: a,b`` + primary authRole */
  roles: string[];
  /** Where primary role came from when not on TC */
  roleSource?: "tc" | "analysis" | "project-default";
};

export type DeriveAuthContextOptions = {
  /** Auth Discover / project E2E default role when TC has no authRole */
  fallbackRole?: string | null;
  /** Analysis actors (WHO) — first usable slug when TC has no role */
  analysisActors?: string[] | null;
};

const AUTH_ROLE_RE =
  /(?:authRole|auth_role)\s*[:=]\s*([A-Za-z0-9_-]+)|\brole\s*[:=]\s*([A-Za-z0-9_-]+)|(?:logged\s+in\s+as|với\s+quyền)\s+([A-Za-z0-9_-]+)/i;
const AUTH_REQ_RE =
  /(?:authRequired|auth_required|cần\s*đăng\s*nhập)\s*[:=]\s*(true|false|yes|no|1|0)/i;
const ROLES_RE = /(?:roles|multiRoleRoles)\s*[:=]\s*([^\n]+)/i;

function cleanRoleSlug(raw: string | null | undefined): string {
  const s = (raw || "").trim().replace(/^["']|["']$/g, "");
  if (!s) return "";
  if (/thi[eế]u\s*context|tbd|n\/a|todo|null|undefined/i.test(s)) return "";
  if (/^(role|actor|user|auth)$/i.test(s)) return "";
  return s;
}

export function deriveAuthContextFromTestCase(
  tc: {
    title?: string | null;
    precondition?: string | null;
    testData?: string | null;
    steps?: string | null;
  },
  opts?: DeriveAuthContextOptions
): AuthContextFromTc {
  const blob = [tc.precondition, tc.testData, tc.steps, tc.title]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("\n");

  const parts: string[] = [];
  const roleM = AUTH_ROLE_RE.exec(blob);
  let role = cleanRoleSlug(roleM?.[1] || roleM?.[2] || roleM?.[3]);
  let roleSource: AuthContextFromTc["roleSource"] | undefined = role
    ? "tc"
    : undefined;
  const roles: string[] = [];

  if (!role) {
    for (const actor of opts?.analysisActors || []) {
      const slug = cleanRoleSlug(actor);
      if (slug) {
        role = slug;
        roleSource = "analysis";
        break;
      }
    }
  }
  if (!role) {
    const fb = cleanRoleSlug(opts?.fallbackRole);
    if (fb) {
      role = fb;
      roleSource = "project-default";
    }
  }

  if (role) {
    parts.push(`actor=${role}`, `authRole=${role}`);
    roles.push(role);
    if (roleSource && roleSource !== "tc") {
      parts.push(`authRoleSource=${roleSource}`);
    }
  }

  const authM = AUTH_REQ_RE.exec(blob);
  if (authM) {
    const v = authM[1].toLowerCase();
    const req = v === "true" || v === "yes" || v === "1";
    parts.push(`authRequired=${req ? "true" : "false"}`);
  } else if (role || /đã\s*đăng\s*nhập|authenticated|logged\s*in/i.test(blob)) {
    parts.push("authRequired=true");
  }

  const rolesM = ROLES_RE.exec(blob);
  if (rolesM) {
    parts.push(`roles=${rolesM[1].trim()}`);
    for (const piece of rolesM[1].split(/[,|;/\s]+/)) {
      const slug = cleanRoleSlug(piece);
      if (slug && !roles.includes(slug)) roles.push(slug);
    }
  }

  return {
    executionContext: parts.join("; "),
    role: role || undefined,
    roles,
    roleSource,
  };
}
