/**

 * Derive WHO auth signals from Approved TC (precondition/testData) for codegen + env.

 * Does not invent roles — only echoes explicit markers.

 */



export type AuthContextFromTc = {

  executionContext: string;

  role?: string;

  /** All actors from ``roles: a,b`` + primary authRole */

  roles: string[];

};



const AUTH_ROLE_RE = /(?:authRole|auth_role|role)\s*[:=]\s*([^\n;,|]+)/i;

const AUTH_REQ_RE =

  /(?:authRequired|auth_required|cần\s*đăng\s*nhập)\s*[:=]\s*(true|false|yes|no|1|0)/i;

const ROLES_RE = /(?:roles|multiRoleRoles)\s*[:=]\s*([^\n]+)/i;



export function deriveAuthContextFromTestCase(tc: {

  title?: string | null;

  precondition?: string | null;

  testData?: string | null;

  steps?: string | null;

}): AuthContextFromTc {

  const blob = [tc.precondition, tc.testData, tc.steps, tc.title]

    .map((s) => (s || "").trim())

    .filter(Boolean)

    .join("\n");

  const parts: string[] = [];

  const roleM = AUTH_ROLE_RE.exec(blob);

  const role = roleM?.[1]?.trim().replace(/^["']|["']$/g, "") || undefined;

  const roles: string[] = [];

  if (role) {

    parts.push(`actor=${role}`, `authRole=${role}`);

    roles.push(role);

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

      const slug = piece.trim().replace(/^["']|["']$/g, "");

      if (slug && !roles.includes(slug)) roles.push(slug);

    }

  }

  return {

    executionContext: parts.join("; "),

    role: role || undefined,

    roles,

  };

}


