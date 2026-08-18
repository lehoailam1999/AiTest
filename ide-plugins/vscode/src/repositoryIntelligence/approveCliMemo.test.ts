import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RepositoryRevision } from "@aitest/ide-protocol";
import { createApproveCliMemo, repositoryMemoKey } from "./approveCliMemo";
import { sha256 } from "./hash";
import type { FieldBindingPickCandidate } from "./resolveBindings";
import type { SymbolProposerInput } from "./symbolProposer";

function revision(overrides?: Partial<RepositoryRevision>): RepositoryRevision {
  return {
    workspaceId: sha256("d:/repo"),
    vcs: "git",
    head: "abc123",
    dirty: false,
    capturedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function proposerInput(
  overrides?: Partial<SymbolProposerInput>
): SymbolProposerInput {
  return {
    title: "Ghi nhận mã vật chứng",
    module: "Vật chứng",
    requirement: "Evidence.Create",
    expected: "Hệ thống lưu mã vật chứng",
    primaryBucket: "VALIDATION_DATA",
    scenario: "POSITIVE",
    expectedType: "success",
    steps: ["Nhập mã"],
    fields: ["maVatChung"],
    inputKeys: ["maVatChung"],
    existingCandidates: [{ name: "EvidenceCreateCommandHandler", pathRel: "a.cs" }],
    timeoutMs: 60_000,
    ...overrides,
  };
}

function candidate(
  property: string,
  ownerPath = "src/Evidence.cs"
): FieldBindingPickCandidate {
  return { property, ownerType: "EvidenceDto", ownerPath, displayNames: [] };
}

describe("approve CLI memo — symbol proposals", () => {
  it("answers a sibling TC of the same module and bucket without a CLI call", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const proposer = memo.wrapProposer(async () => {
      calls += 1;
      return { symbols: ["EvidenceCreateCommandHandler"], paths: ["a.cs"] };
    }, repositoryMemoKey(revision()))!;

    const first = await proposer(proposerInput());
    // Different title and steps, same module/bucket/fields — same question.
    const second = await proposer(
      proposerInput({ title: "Bỏ trống mã vật chứng", steps: ["Để trống mã"] })
    );

    assert.equal(calls, 1);
    assert.deepEqual(second.symbols, first.symbols);
    assert.equal(second.memoHit, true);
    assert.equal(first.memoHit, undefined);
  });

  it("shares one answer across a module's per-field validation TCs", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const proposer = memo.wrapProposer(async () => {
      calls += 1;
      return { symbols: ["EvidenceCreateCommandHandler"], paths: [] };
    }, repositoryMemoKey(revision()))!;

    // Same module and behaviour class, one TC per field — same handler.
    await proposer(proposerInput({ fields: ["maVatChung"], inputKeys: ["maVatChung"] }));
    await proposer(proposerInput({ fields: ["hoSoVuAn"], inputKeys: ["hoSoVuAn"] }));
    await proposer(
      proposerInput({ fields: ["thoiGianThuGiu"], inputKeys: ["thoiGianThuGiu"] })
    );
    assert.equal(calls, 1);
  });

  it("asks again when the behaviour class differs", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const proposer = memo.wrapProposer(async () => {
      calls += 1;
      return { symbols: ["Handler"], paths: [] };
    }, repositoryMemoKey(revision()))!;

    await proposer(proposerInput());
    await proposer(proposerInput({ primaryBucket: "AUTHORIZATION" }));
    await proposer(proposerInput({ scenario: "NEGATIVE" }));
    await proposer(proposerInput({ expectedType: "rejection" }));
    assert.equal(calls, 4);
  });

  it("asks again for a different module", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const proposer = memo.wrapProposer(async () => {
      calls += 1;
      return { symbols: ["Handler"], paths: [] };
    }, repositoryMemoKey(revision()))!;

    await proposer(proposerInput());
    await proposer(proposerInput({ module: "Hồ sơ vụ án" }));
    assert.equal(calls, 2);
  });

  it("asks again when the repository moved", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const answer = async () => {
      calls += 1;
      return { symbols: ["Handler"], paths: [] };
    };

    await memo.wrapProposer(answer, repositoryMemoKey(revision()))!(proposerInput());
    await memo.wrapProposer(
      answer,
      repositoryMemoKey(revision({ head: "def456" }))
    )!(proposerInput());
    assert.equal(calls, 2);
  });

  it("re-asks a dirty workspace once its fingerprint changes", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const answer = async () => {
      calls += 1;
      return { symbols: ["Handler"], paths: [] };
    };
    const dirty = (fingerprint: string) =>
      repositoryMemoKey(
        revision({ dirty: true, dirtyFingerprint: sha256(fingerprint) })
      );

    await memo.wrapProposer(answer, dirty("v1"))!(proposerInput());
    await memo.wrapProposer(answer, dirty("v1"))!(proposerInput());
    await memo.wrapProposer(answer, dirty("v2"))!(proposerInput());
    assert.equal(calls, 2);
  });

  it("never caches a failed or empty proposal", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const proposer = memo.wrapProposer(async () => {
      calls += 1;
      return { symbols: [], paths: [], error: "AI CLI timed out after 60000ms" };
    }, repositoryMemoKey(revision()))!;

    await proposer(proposerInput());
    await proposer(proposerInput());
    assert.equal(calls, 2);
  });

  it("expires a cached answer after its TTL", async () => {
    let clock = 1_000;
    const memo = createApproveCliMemo({ ttlMs: 5_000, now: () => clock });
    let calls = 0;
    const proposer = memo.wrapProposer(async () => {
      calls += 1;
      return { symbols: ["Handler"], paths: [] };
    }, repositoryMemoKey(revision()))!;

    await proposer(proposerInput());
    clock += 4_000;
    await proposer(proposerInput());
    clock += 6_000;
    await proposer(proposerInput());
    assert.equal(calls, 2);
  });
});

describe("approve CLI memo — field binding picks", () => {
  const pickerInput = (
    labels: string[],
    candidates: FieldBindingPickCandidate[]
  ) => ({
    labels,
    inputKeys: labels,
    testCaseTitle: "TC",
    module: "Vật chứng",
    expected: "saved",
    candidates,
    timeoutMs: 30_000,
  });

  it("reuses a label already mapped for an earlier TC", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const picker = memo.wrapPicker(async (input) => {
      calls += 1;
      return {
        picks: input.labels.map((label) => ({
          label,
          property: "EvidenceCode",
          ownerPath: "src/Evidence.cs",
        })),
        missing: [],
        engine: "cursor-agent",
      };
    }, repositoryMemoKey(revision()))!;

    const candidates = [candidate("EvidenceCode"), candidate("Description")];
    await picker(pickerInput(["maVatChung"], candidates));
    const second = await picker(pickerInput(["maVatChung"], candidates));

    assert.equal(calls, 1);
    assert.equal(second.memoHit, true);
    assert.deepEqual(second.picks, [
      { label: "maVatChung", property: "EvidenceCode", ownerPath: "src/Evidence.cs" },
    ]);
  });

  it("only asks about the labels it has not seen", async () => {
    const memo = createApproveCliMemo();
    const asked: string[][] = [];
    const picker = memo.wrapPicker(async (input) => {
      asked.push([...input.labels]);
      return {
        picks: input.labels.map((label) => ({
          label,
          property: label === "maVatChung" ? "EvidenceCode" : "Description",
          ownerPath: "src/Evidence.cs",
        })),
        missing: [],
      };
    }, repositoryMemoKey(revision()))!;

    const candidates = [candidate("EvidenceCode"), candidate("Description")];
    await picker(pickerInput(["maVatChung"], candidates));
    const second = await picker(pickerInput(["maVatChung", "moTa"], candidates));

    assert.deepEqual(asked, [["maVatChung"], ["moTa"]]);
    assert.equal(second.picks.length, 2);
    assert.equal(second.memoHit, undefined);
  });

  it("re-asks when the cached property is absent from this shortlist", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const picker = memo.wrapPicker(async (input) => {
      calls += 1;
      return {
        picks: input.labels.map((label) => ({
          label,
          property: "EvidenceCode",
          ownerPath: "src/Evidence.cs",
        })),
        missing: [],
      };
    }, repositoryMemoKey(revision()))!;

    await picker(pickerInput(["maVatChung"], [candidate("EvidenceCode")]));
    await picker(
      pickerInput(["maVatChung"], [candidate("EvidenceCode", "src/Other.cs")])
    );
    assert.equal(calls, 2);
  });

  it("keeps a cached 'absent from source' verdict only for an identical shortlist", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const picker = memo.wrapPicker(async (input) => {
      calls += 1;
      return { picks: [], missing: [...input.labels] };
    }, repositoryMemoKey(revision()))!;

    const candidates = [candidate("EvidenceCode")];
    await picker(pickerInput(["vatChungKyThuatSo"], candidates));
    const cached = await picker(pickerInput(["vatChungKyThuatSo"], candidates));
    assert.equal(calls, 1);
    assert.deepEqual(cached.missing, ["vatChungKyThuatSo"]);

    // A wider shortlist may hold the property, so the gap must be re-checked.
    await picker(
      pickerInput(["vatChungKyThuatSo"], [...candidates, candidate("DigitalEvidence")])
    );
    assert.equal(calls, 2);
  });

  it("does not cache a pick that is outside the offered shortlist", async () => {
    const memo = createApproveCliMemo();
    let calls = 0;
    const picker = memo.wrapPicker(async () => {
      calls += 1;
      return {
        picks: [
          { label: "maVatChung", property: "Invented", ownerPath: "src/Nope.cs" },
        ],
        missing: [],
      };
    }, repositoryMemoKey(revision()))!;

    const candidates = [candidate("EvidenceCode")];
    await picker(pickerInput(["maVatChung"], candidates));
    await picker(pickerInput(["maVatChung"], candidates));
    assert.equal(calls, 2);
  });
});
