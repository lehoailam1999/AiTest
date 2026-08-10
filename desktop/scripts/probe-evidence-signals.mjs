import fs from "node:fs";
import path from "node:path";

const root = "D:/Xlab/Forensic/forensic";
const targets = [
  "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
  "src/Forensic.Application/Commands/CaseRecord/CaseRecordCreateCommandHandler.cs",
];

function scan(rel) {
  const t = fs.readFileSync(path.join(root, rel), "utf8");
  const keys = [
    ...t.matchAll(/[A-Za-z][A-Za-z0-9]*(Code|Exists|Duplicate|Unique)[A-Za-z0-9]*/g),
  ].map((m) => m[0]);
  const quoted = [...t.matchAll(/["']([A-Za-z][A-Za-z0-9_]{3,})["']/g)].map(
    (m) => m[1]
  );
  console.log("==", path.basename(rel));
  console.log("keys", [...new Set(keys)].slice(0, 25));
  console.log(
    "quoted",
    [...new Set(quoted)].filter((x) =>
      /code|exist|dupli|evidence|case|record|alert/i.test(x)
    )
  );
  console.log("has VI vat/chung", /v[aạ]t|ch[uứ]ng/i.test(t));
}

for (const f of targets) scan(f);

// Grep index.db for paths mentioning Evidence near CheckCode
const raw = fs.readFileSync(path.join(root, ".ai-test/index.db"), "utf8");
const evid = (raw.match(/Evidence[A-Za-z0-9]*CheckCode[A-Za-z0-9]*/g) || []).slice(0, 10);
const casec = (raw.match(/CaseRecord[A-Za-z0-9]*CheckCode[A-Za-z0-9]*/g) || []).slice(0, 10);
console.log({ evid, casec });

// Count source files containing Vietnamese requirement words
let hitE = 0, hitC = 0, hitViInEvidence = 0;
function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (/node_modules|bin|obj|\.git/i.test(n)) continue;
      walk(p);
    } else if (/\.(cs|ts|tsx|json|resx|md)$/i.test(n)) {
      let t = "";
      try { t = fs.readFileSync(p, "utf8"); } catch { continue; }
      const rel = p.slice(root.length + 1).replace(/\\/g, "/");
      if (/v[aạăắằặảãáà]t\s*ch[uứưửữựủũúù]ng|vat\s*chung/i.test(t)) {
        if (/Evidence/i.test(rel)) hitViInEvidence++;
        console.log("VI hit", rel.slice(0, 120));
      }
    }
  }
}
walk(path.join(root, "src"));
console.log({ hitViInEvidence });
