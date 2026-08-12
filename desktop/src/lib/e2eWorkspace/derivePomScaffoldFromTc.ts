type TcLike = {
  title?: string | null;
  steps?: string | null;
  precondition?: string | null;
  expectedResult?: string | null;
  expected_result?: string | null;
};

function preconditionNeedsCreateModal(precondition: string): boolean {
  const p = (precondition || "").trim();
  if (!p) return false;
  return /(popup|modal|dialog|popup\s*tạo|mở\s*(form|popup|modal|dialog)|open\s*(create|modal|dialog)|nút\s*tạo)/i.test(
    p
  );
}

function toPascal(input: string): string {
  const cleaned = (input || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

function methodFromStep(step: string): string {
  const s = (step || "").trim().toLowerCase();
  if (!s) return "performStep";
  if (/(m[oơ]|open|navigate|goto|truy c[aậ]p|v[aà]o trang)/i.test(s)) return "gotoFeature";
  if (/(click|nh[aấ]n|b[aấ]m).*(t[aạ]o m[oớ]i|create|add)/i.test(s)) return "openCreateForm";
  // Checkbox / toggle before generic "chọn" (avoid selectOption for "tick chọn checkbox")
  // Do not use bare /tắt|tat/ — collides with English "status".
  if (
    /(checkbox|tick|\bcheck\b|\buncheck\b)/i.test(s) ||
    /(bật|tắt|b[aậ]t|t[aắ]t).{0,24}(checkbox|ch[oọ]n)/i.test(s) ||
    /(tick|check).{0,12}(ch[oọ]n)/i.test(s)
  ) {
    return "toggleCheckbox";
  }
  if (/(nh[aậ]p|fill|input|g[oõ])/i.test(s)) {
    const m = s.match(
      /(email|password|title|name|description|code|status|search|keyword|username|phone)/
    );
    const suffix = toPascal(m?.[1] || "Field");
    return `fill${suffix || "Field"}`;
  }
  if (/(select|dropdown|combobox|ch[oọ]n\s+(status|type|category|role|option))/i.test(s)) {
    const m = s.match(/(status|type|category|role|module|option)/);
    const suffix = toPascal(m?.[1] || "Option");
    return `select${suffix || "Option"}`;
  }
  if (/(upload|t[aả]i l[eê]n|file|t[eệ]p|attachment)/i.test(s)) return "uploadAttachment";
  if (/(save|submit|l[uư]u|x[aá]c nh[aậ]n|ho[aà]n t[aấ]t)/i.test(s)) return "submitForm";
  if (/(verify|assert|ki[eể]m tra|expect|quan s[aá]t|hi[eể]n th[iị])/i.test(s)) {
    return "expectExpectedState";
  }
  if (/(search|t[iì]m ki[eế]m|filter|l[oọ]c)/i.test(s)) return "searchByKeyword";
  return "performStep";
}

function splitSteps(raw: string): string[] {
  const lines = (raw || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  return lines.map((ln) => ln.replace(/^\d+[\.\):\-]\s*/, "").trim());
}

export function derivePomScaffoldFromTc(opts: {
  testCase: TcLike;
  featurePath?: string;
}): string {
  const title = (opts.testCase.title || "Feature flow").trim();
  const className = `${toPascal(title).slice(0, 48) || "Feature"}Page`;
  const steps = splitSteps(opts.testCase.steps || "");
  const expected = (opts.testCase.expectedResult || opts.testCase.expected_result || "").trim();

  const methodMap = steps.map((step, idx) => ({
    idx: idx + 1,
    step,
    method: methodFromStep(step),
  }));
  const uniqueMethods = Array.from(new Set(methodMap.map((x) => x.method)));
  if (!uniqueMethods.includes("gotoFeature")) uniqueMethods.unshift("gotoFeature");
  const needOpenCreate =
    preconditionNeedsCreateModal(opts.testCase.precondition || "") &&
    !uniqueMethods.includes("openCreateForm");
  if (needOpenCreate) {
    const gotoIdx = uniqueMethods.indexOf("gotoFeature");
    uniqueMethods.splice(gotoIdx >= 0 ? gotoIdx + 1 : 0, 0, "openCreateForm");
  }
  if (!uniqueMethods.includes("expectExpectedState")) uniqueMethods.push("expectExpectedState");

  const lines: string[] = [];
  lines.push(`# class: ${className}`);
  if (opts.featurePath) lines.push(`featurePath: ${opts.featurePath}`);
  lines.push("requiredMethods:");
  for (const method of uniqueMethods) {
    lines.push(`- ${method}(...args: unknown[]): Promise<void>`);
  }
  lines.push("stepToMethod:");
  if (needOpenCreate) {
    lines.push(
      `- 0. [precondition] open create popup/modal => openCreateForm (after gotoFeature, before Act)`
    );
  }
  for (const row of methodMap) {
    lines.push(`- ${row.idx}. ${row.step || "(empty)"} => ${row.method}`);
  }
  if (expected) lines.push(`expectedAssertHint: ${expected}`);
  lines.push(
    "rules: TC-literal only; implement locators from FE/DOM; never Phase-3 throw stubs; omit methods not in TC/precondition"
  );
  return lines.join("\n");
}
