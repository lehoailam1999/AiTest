import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forcePacketPrimary } from "./forcePacketPrimary";
import type { AITestContextPacket } from "./types";

function basePacket(files: AITestContextPacket["files"]): AITestContextPacket {
  return {
    packetVersion: 1,
    purpose: "generate-unit",
    meta: {},
    files,
    diagnostics: { truncated: [], omittedPaths: [] },
    sourceUnderTest: { pathRel: files[0]?.pathRel, symbol: "IUploadService" },
  };
}

describe("forcePacketPrimary", () => {
  it("rewrites I* primary to UploadService and strips absolute paths", async () => {
    const packet = basePacket([
      {
        pathRel: "D:/Xlab/Forensic/forensic/src/Forensic.Infrastructure/Services/IUploadService.cs",
        role: "primary",
        content: "public interface IUploadService {}",
      },
      {
        pathRel: "src/Forensic.Infrastructure/Services/UploadService.cs",
        role: "dependency",
        content: "public class UploadService { public void Init() {} }",
      },
    ]);
    const out = await forcePacketPrimary({
      packet,
      primaryRel: "src/Forensic.Infrastructure/Services/UploadService.cs",
      projectRoot: "D:/Xlab/Forensic/forensic",
    });
    assert.equal(
      out.files[0]?.pathRel,
      "src/Forensic.Infrastructure/Services/UploadService.cs"
    );
    assert.equal(out.files[0]?.role, "primary");
    assert.match(out.files[0]?.content || "", /class UploadService/);
    assert.equal(out.sourceUnderTest?.pathRel, out.files[0]?.pathRel);
    assert.equal(out.sourceUnderTest?.symbol, "UploadService");
    assert.ok(
      !out.files.some((f) => /^[a-z]:\//i.test(f.pathRel)),
      "no absolute pathRel"
    );
  });
});
