/**
 * Probe TC-010 resolve — Module → Function → Title (BE logic layer only).
 * Run: node scripts/probe-tc010-resolve.mjs
 */
import assert from "node:assert/strict";
import {
  buildUnitApproveQuery,
  resolveUnitPrimaryFromIndex,
  snapshotFromPaths,
} from "../src/lib/unitResolve/index.js";
import {
  filterUnitLogicLayerPaths,
  isPreferredLogicLayerPath,
} from "@aitest/ide-protocol";

/** Fixture mirrors Forensic.Application layout (portable names — no hardcoded product in resolve). */
const PATHS = [
  "src/Forensic.Application/Commands/User/UserCreateCommandHandler.cs",
  "src/Forensic.Application/Commands/User/UserOrgUnitCreateCommandHandler.cs",
  "src/Forensic.Application/Commands/User/UserCreateCommand.cs",
  "src/Forensic.Application/Commands/CaseRecord/CaseRecordCreateCommandHandler.cs",
  "src/Forensic.Application/Commands/CaseRecord/CaseRecordCreateCommand.cs",
  "src/Forensic.Application/Commands/CaseRecord/AssignInvestigatorCommandHandler.cs",
  "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
  "src/Forensic.Application/Commands/Evidence/AssignEvidenceToCaseCommandHandler.cs",
  "src/Forensic.Application/Queries/CaseRecord/ListAvailableCaseRecordsQueryHandler.cs",
  "src/Forensic.ClientApp/src/app/features/evidence/assign-case.component.ts",
];

const BODIES = {
  "src/Forensic.Application/Commands/User/UserCreateCommandHandler.cs":
    "class UserCreateCommandHandler { void H() { Create(); } }",
  "src/Forensic.Application/Commands/User/UserOrgUnitCreateCommandHandler.cs":
    "class UserOrgUnitCreateCommandHandler { void H() { Create(); } }",
  "src/Forensic.Application/Commands/CaseRecord/CaseRecordCreateCommandHandler.cs":
    "class CaseRecordCreateCommandHandler { void H() { Create(); Save(); } }",
  "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs":
    "class EvidenceCreateCommandHandler { void H() { Create(); } }",
  "src/Forensic.Application/Commands/Evidence/AssignEvidenceToCaseCommandHandler.cs": `
    public class AssignEvidenceToCaseCommandHandler {
      public async Task Handle(AssignEvidenceToCaseCommand cmd) {
        var userId = cmd.UserId;
        var cases = await _repo.ListJoinedOrManagedAsync(userId);
        return cases.Where(c => c.UserCanAccess(userId));
      }
    }`,
  "src/Forensic.Application/Queries/CaseRecord/ListAvailableCaseRecordsQueryHandler.cs": `
    public class ListAvailableCaseRecordsQueryHandler {
      public async Task<IEnumerable<CaseRecord>> Handle(ListAvailableCaseRecordsQuery q) {
        return await _repo.FilterByParticipationOrManagementAsync(q.UserId);
      }
    }`,
  "src/Forensic.ClientApp/src/app/features/evidence/assign-case.component.ts":
    "export class AssignCaseComponent { ngOnInit() {} }",
};

const TC = {
  title:
    "Gán vật chứng vào hồ sơ vụ án - lọc theo quyền - Chỉ trả vụ án được tham gia hoặc quản lý",
  module: "Gán vật chứng vào hồ sơ vụ án",
  steps:
    "1. Chuẩn bị userId và tập vụ án hỗn hợp quyền\n2. Mock repo trả toàn bộ; đơn vị lọc theo tham gia/quản lý\n3. Gọi đơn vị lấy danh sách hồ sơ vụ án khả dụng\n4. Assert kết quả lọc",
  expectedResult:
    "Chỉ trả các vụ án người dùng được tham gia hoặc quản lý; loại bỏ vụ án ngoài quyền",
  testData: "trace: BUSINESS_RULES/BR-7; input=user có quyền tập con vụ án",
};

const ALIASES = {
  "vat chung": ["Evidence"],
  "ho so vu an": ["CaseRecord", "Case"],
  evidence: ["Evidence"],
};

const snap = snapshotFromPaths(PATHS);
const logicPaths = filterUnitLogicLayerPaths(PATHS);
const query = buildUnitApproveQuery(TC, {
  requirementTitle: "Tạo mới vật chứng",
  projectAliases: ALIASES,
});

console.log("=== TC-010 probe (Module → Function → Title) ===\n");
console.log("Module (Studio):     Tạo mới vật chứng");
console.log("Function (tc.module): Gán vật chứng vào hồ sơ vụ án");
console.log("Title:", TC.title.slice(0, 60) + "…\n");

console.log("Logic-layer pool (BE only):");
for (const p of logicPaths) {
  const pref = isPreferredLogicLayerPath(p) ? "★" : " ";
  console.log(`  ${pref} ${p}`);
}
console.log(
  `\nFE excluded: ${PATHS.length - logicPaths.length} path(s)\n`
);

console.log("Intent:", query.intent.primaryClass, query.intent.classes?.slice(0, 3));
console.log("Keywords:", query.keywords.slice(0, 8).join(", "));
console.log("");

const r = await resolveUnitPrimaryFromIndex({
  codeIndex: snap,
  query,
  readExcerpt: async (p) => BODIES[p] || "",
});

console.log("--- Resolve result ---");
console.log("writeBack:", r.writeBack);
console.log("skipReason:", r.skipReason || "(none)");
console.log("notes:", (r.notes || []).join(" | "));
console.log("bodyRuleLog:", r.bodyRuleLog || "(none)");
console.log("\ntop3:");
for (const c of r.candidatesTop3 || []) {
  console.log(`  ${c.score}\t${c.pathRel}`);
}
if (r.seed) {
  console.log("\n✓ seed:", r.seed.pathRel);
  console.log("  symbol:", r.symbol);
  console.log("  related:", (r.relatedPaths || []).slice(0, 4).join(", "));
}

// Assertions — BE logic, not User*/CaseRecordCreate/FE
const tops = (r.candidatesTop3 || []).map((c) => c.pathRel);
const allTop = [r.seed?.pathRel, ...tops].filter(Boolean);
const noUser = allTop.every((p) => !/UserCreate|UserOrgUnit/i.test(p));
const noFe = allTop.every((p) => !/ClientApp|\.component\./i.test(p));
const noWrongCreate = !/CaseRecordCreateCommandHandler/i.test(
  r.seed?.pathRel || tops[0] || ""
);

console.log("\n--- Checks ---");
console.log("✓ No User* latch:", noUser ? "PASS" : "FAIL");
console.log("✓ No FE component:", noFe ? "PASS" : "FAIL");
console.log("✓ Not CaseRecordCreate (wrong op):", noWrongCreate ? "PASS" : "FAIL");
const beHit =
  /Evidence|CaseRecord|Assign|ListAvailable/i.test(r.seed?.pathRel || tops[0] || "");
console.log("✓ BE assign/filter handler:", beHit ? "PASS" : "FAIL");

try {
  assert.ok(noUser, "User* should not rank for evidence assign TC");
  assert.ok(noFe, "FE paths excluded");
  assert.ok(noWrongCreate, "Create handler wrong for filter TC");
  assert.ok(beHit, "Expected Evidence/CaseRecord assign or list query handler");
  console.log("\n=== OVERALL: PASS ===");
  process.exit(0);
} catch (e) {
  console.log("\n=== OVERALL: FAIL ===");
  console.error(e.message);
  process.exit(1);
}
