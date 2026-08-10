import fs from "node:fs";
import path from "node:path";

const root = "D:/Xlab/Forensic/forensic";
const files = [
  "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
  "src/Forensic.Application/Commands/CaseRecord/CaseRecordCreateCommandHandler.cs",
  "src/Forensic.Application/Commands/Role/RoleCreateCommandHandler.cs",
];

function strip(s) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

for (const rel of files) {
  const t = fs.readFileSync(path.join(root, rel), "utf8");
  const ascii = strip(t);
  console.log("==", path.basename(rel));
  for (const needle of [
    "vat chung",
    "ma vat",
    "chung cu",
    "ho so",
    "case",
    "evidence",
  ]) {
    console.log(needle, ascii.includes(needle.replace(/\s+/g, " ")));
  }
  // show windows around vat
  let idx = ascii.indexOf("vat");
  let n = 0;
  while (idx >= 0 && n < 5) {
    console.log("ctx:", JSON.stringify(ascii.slice(Math.max(0, idx - 20), idx + 40)));
    idx = ascii.indexOf("vat", idx + 1);
    n++;
  }
}
