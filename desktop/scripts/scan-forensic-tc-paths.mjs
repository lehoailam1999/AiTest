/**
 * Scan Forensic .ai-test/test-cases for path/code coverage.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/Xlab/Forensic/forensic/.ai-test/test-cases";

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/^TC-.*\.md$/i.test(ent.name)) out.push(p);
  }
  return out;
}

function meta(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : "";
}

const files = walk(ROOT);
const rows = [];
for (const file of files) {
  const t = fs.readFileSync(file, "utf8");
  const paths = [...t.matchAll(/^path:\s*(.+)$/gm)].map((m) => m[1].trim());
  const codes = [...t.matchAll(/^code:\s*(.+)$/gm)].map((m) => m[1].trim());
  const skip =
    t.match(/# sut-resolve:\s*skipped\s*[—\-:]\s*(.+)$/m)?.[1]?.trim() ||
    t.match(/# sut-resolve:\s*skipped\s+(.+)$/m)?.[1]?.trim() ||
    "";
  const has = paths.length > 0 && codes.length > 0;
  rows.push({
    tc: meta(t, "testCaseId") || path.basename(file, ".md"),
    mod: meta(t, "module"),
    req: meta(t, "requirement"),
    has,
    path: paths[0] || "",
    reason: skip || (!has ? "no path/code" : ""),
    rel: path.relative(ROOT, file),
  });
}

const withP = rows.filter((r) => r.has);
const without = rows.filter((r) => !r.has);

function bucket(reason) {
  if (/FAIL_FEATURE_GAP/i.test(reason)) return "FEATURE_GAP (UI/scope)";
  if (/ambiguous/i.test(reason)) return "ambiguous margin";
  if (/body-rule/i.test(reason)) return "body-rule fail";
  if (/no confident/i.test(reason)) return "no confident match";
  if (/SOFT_NO_DOMAIN/i.test(reason)) return "soft_no_domain";
  if (/unresolved/i.test(reason)) return "unresolved";
  if (!reason || reason === "no path/code") return "no path/code (no skip note)";
  return reason.slice(0, 50);
}

const buckets = {};
for (const r of without) {
  const k = bucket(r.reason);
  buckets[k] = (buckets[k] || 0) + 1;
}

console.log(`TOTAL=${rows.length} WITH_PATH=${withP.length} WITHOUT=${without.length}`);
console.log("WITHOUT_BY_REASON:");
for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}
console.log("---WITHOUT---");
for (const r of without.sort((a, b) => a.tc.localeCompare(b.tc, undefined, { numeric: true }))) {
  console.log(`${r.tc}\t${r.mod.slice(0, 42)}\t${r.reason.slice(0, 100)}`);
}
console.log("---WITH---");
for (const r of withP.sort((a, b) => a.tc.localeCompare(b.tc, undefined, { numeric: true }))) {
  console.log(`${r.tc}\t${r.path.split("/").pop()}\t${r.mod.slice(0, 36)}`);
}
