import fs from "fs";
import {
  bridgeNeedlesForDiscover,
  discoverFeatureFoldersFromIndex,
} from "@aitest/ide-protocol";
import { parseSnapshotJson } from "../src/lib/codeIndex/indexStore.ts";
import { toRepoRelativePath } from "../src/lib/approvedTcSync/enrichUnitMarkersFromIndex.ts";
import { buildUnitApproveQuery } from "../src/lib/unitResolve/buildUnitApproveQuery.ts";
import { extractMatchTokens } from "../src/lib/projectIntelligence/tcSeedResolver.ts";
import { extractTechIdentifierStems } from "../src/lib/approvedTcSync/progressiveSeedFromCodeIndex.ts";

const FORENSIC = "D:/Xlab/Forensic/forensic";
const tcs = JSON.parse(
  fs.readFileSync(new URL("./.tmp-forensic-tcs-from-db.json", import.meta.url), "utf8")
);
const rawTc = tcs.find((t) => t.testCaseId === "TC-017");
const snap = parseSnapshotJson(
  fs.readFileSync(`${FORENSIC}/.ai-test/index.db`, "utf8")
);
const paths = Object.keys(snap.files || {}).map(
  (k) => toRepoRelativePath(k, FORENSIC) || k.replace(/\\/g, "/")
);
const files = Object.fromEntries(paths.map((p) => [p, {}]));
const index = { files, symbolsByFile: {}, symbolIndex: {} };
for (const [k, v] of Object.entries(snap.symbolsByFile || {})) {
  index.symbolsByFile[toRepoRelativePath(k, FORENSIC) || k.replace(/\\/g, "/")] =
    v;
}
for (const [sym, plist] of Object.entries(snap.symbolIndex || {})) {
  index.symbolIndex[sym] = (plist || []).map(
    (p) => toRepoRelativePath(p, FORENSIC) || String(p).replace(/\\/g, "/")
  );
}

const tc = {
  title: rawTc.title,
  module: rawTc.module,
  steps: rawTc.steps,
  expectedResult: rawTc.expectedResult,
  testData: rawTc.testData || "",
  precondition: rawTc.precondition || "",
};
const q = buildUnitApproveQuery(tc, { requirementTitle: "Tạo mới vật chứng" });
const titleTokens = [
  q.module,
  q.title,
  q.requirementTitle,
  ...extractMatchTokens(q.module || "", q.projectAliases, paths),
  ...extractMatchTokens(q.title || "", q.projectAliases, paths),
  ...extractMatchTokens(q.requirementTitle || "", q.projectAliases, paths),
  ...extractTechIdentifierStems(q.tcBlob),
  ...(q.preferTokens || []),
].slice(0, 32);

console.log(
  JSON.stringify(
    {
      personTokens: titleTokens.filter((t) => /person|nguoi|owner/i.test(t)),
      titleTokens: titleTokens.slice(0, 32),
      prefer: q.preferTokens.slice(0, 20),
      intentRules: (q.intent.rulePatterns || []).slice(0, 8),
      needles: bridgeNeedlesForDiscover(q.intent, titleTokens),
      discover: discoverFeatureFoldersFromIndex(index, paths, {
        intent: q.intent,
        titleTokens,
      }),
    },
    null,
    2
  )
);
