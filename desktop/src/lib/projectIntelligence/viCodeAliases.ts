/**
 * Khớp TC/module tiếng Việt ↔ tên file Latin — không gắn cứng domain dự án.
 *
 * Nguồn token (ưu tiên cao → thấp):
 * 1. Gợi ý tường minh trong notes / testData: code: / path: / alias:
 * 2. Alias do user cấu hình trên project.meta.codeAliases
 * 3. Động từ/danh từ IT chung (rất hẹp) — không gắn nghiệp vụ cụ thể
 * 4. Bỏ dấu + PascalCase từ chính chuỗi VI (extractMatchTokens)
 */

export type CodeAliasMap = Record<string, string[]>;

/** Chỉ động từ/hành động IT chung — dùng được mọi dự án. */
export const GENERIC_VI_WORD_ALIASES: CodeAliasMap = {
  tao: ["Create", "Add", "New"],
  moi: ["Create", "New"],
  sua: ["Edit", "Update"],
  xoa: ["Delete", "Remove"],
  xem: ["View", "Get", "Detail"],
  tim: ["Search", "Find", "Query"],
  kiem: ["Search", "Check"],
  dang: ["Auth"],
  nhap: ["Login", "Input", "Import"],
  xuat: ["Export"],
  luu: ["Save"],
  gui: ["Send", "Submit"],
  duyet: ["Approve", "Review"],
  khoa: ["Lock", "Disable"],
  mo: ["Open", "Enable"],
  tai: ["Upload", "Download"],
  api: ["Api", "Controller"],
};

/** Cụm IT chung (không gắn domain nghiệp vụ). */
export const GENERIC_VI_PHRASE_ALIASES: CodeAliasMap = {
  "dang nhap": ["Login", "Auth", "SignIn"],
  "dang ky": ["Register", "SignUp"],
  "quen mat khau": ["ForgotPassword", "ResetPassword"],
  "doi mat khau": ["ChangePassword"],
  "phan quyen": ["Permission", "Authorization", "Role"],
  "nguoi dung": ["User", "Account"],
  "tim kiem": ["Search", "Query", "Filter"],
  "tai len": ["Upload"],
  "tai xuong": ["Download"],
  "xuat file": ["Export"],
  "nhap file": ["Import"],
};

function stripDiacriticsLocal(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function normalizeAliasKey(raw: string): string {
  return stripDiacriticsLocal(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Gộp alias dự án (meta) với bộ IT chung. */
export function mergeCodeAliasMaps(
  projectAliases?: CodeAliasMap | null
): { phrases: CodeAliasMap; words: CodeAliasMap } {
  const phrases: CodeAliasMap = { ...GENERIC_VI_PHRASE_ALIASES };
  const words: CodeAliasMap = { ...GENERIC_VI_WORD_ALIASES };

  if (projectAliases) {
    for (const [k, vals] of Object.entries(projectAliases)) {
      const key = normalizeAliasKey(k);
      if (!key || !Array.isArray(vals) || !vals.length) continue;
      const cleaned = vals.map((v) => String(v).trim()).filter(Boolean);
      if (key.includes(" ")) {
        phrases[key] = [...new Set([...(phrases[key] ?? []), ...cleaned])];
      } else {
        words[key] = [...new Set([...(words[key] ?? []), ...cleaned])];
      }
    }
  }
  return { phrases, words };
}

export function expandVietnameseToCodeTokens(
  raw: string,
  projectAliases?: CodeAliasMap | null
): string[] {
  const ascii = normalizeAliasKey(raw);
  if (!ascii) return [];

  const { phrases, words } = mergeCodeAliasMaps(projectAliases);
  const out: string[] = [];

  for (const [phrase, aliases] of Object.entries(phrases)) {
    if (ascii.includes(phrase)) out.push(...aliases);
  }
  for (const w of ascii.split(" ").filter(Boolean)) {
    const al = words[w];
    if (al) out.push(...al);
  }

  const en = [...new Set(out.filter((x) => /^[A-Za-z]/.test(x)))];
  if (en.length >= 2) {
    out.push(en.slice(0, 3).join(""));
    out.push([...en.slice(0, 3)].reverse().join(""));
  }
  return [...new Set(out)];
}

/**
 * Parse gợi ý tường minh (mọi dự án):
 *   code: MyService
 *   path: Services/Foo
 *   alias: FooController, IFooService
 */
export function parseCodeHintsFromText(text: string | null | undefined): {
  codeTokens: string[];
  pathHints: string[];
} {
  const raw = text || "";
  const codeTokens: string[] = [];
  const pathHints: string[] = [];

  for (const m of raw.matchAll(/(?:^|\n)\s*(?:code|alias)\s*:\s*(.+)$/gim)) {
    codeTokens.push(
      ...m[1]
        .split(/[,;|/]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  for (const m of raw.matchAll(/(?:^|\n)\s*path\s*:\s*(.+)$/gim)) {
    pathHints.push(
      ...m[1]
        .split(/[,;|]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  return {
    codeTokens: [...new Set(codeTokens)],
    pathHints: [...new Set(pathHints)],
  };
}
