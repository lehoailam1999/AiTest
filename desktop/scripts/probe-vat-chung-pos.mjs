import fs from "node:fs";
import path from "node:path";

const root = "D:/Xlab/Forensic/forensic";
const rel =
  "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs";
const t = fs.readFileSync(path.join(root, rel), "utf8");
const ascii = t
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d")
  .toLowerCase();

function findAll(needle) {
  let i = 0;
  while (true) {
    const idx = ascii.indexOf(needle, i);
    if (idx < 0) break;
    console.log(needle, idx, JSON.stringify(ascii.slice(idx - 30, idx + needle.length + 30)));
    i = idx + 1;
  }
}
findAll("vat chung");
findAll("chung cu");
findAll("vat");
// Also check XML docs / comments with original
for (const m of t.matchAll(/\/\/.*|\/\*[\s\S]*?\*\/|"[^"]{5,80}"/g)) {
  const s = m[0];
  if (/v[aạ]|ch[uứ]|chứng|vật/i.test(s)) console.log("comment/str", s.slice(0, 120));
}
