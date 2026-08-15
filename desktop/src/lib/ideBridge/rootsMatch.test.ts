import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ideWorkspaceMatchesProject,
  normalizeFsRoot,
  rootsAligned,
  rootsMismatch,
} from "./rootsMatch.js";

describe("ideWorkspaceMatchesProject", () => {
  it("matches exact path ignoring case and separators", () => {
    assert.equal(
      ideWorkspaceMatchesProject(
        "D:\\Xlab\\Forensic\\forensic",
        "d:/Xlab/Forensic/forensic/"
      ),
      true
    );
  });

  it("matches nested project under IDE workspace", () => {
    assert.equal(
      ideWorkspaceMatchesProject(
        "D:/Xlab/Forensic",
        "D:/Xlab/Forensic/forensic"
      ),
      true
    );
  });

  it("matches IDE workspace nested under project path", () => {
    assert.equal(
      ideWorkspaceMatchesProject(
        "D:/Xlab/Forensic/forensic/src",
        "D:/Xlab/Forensic/forensic"
      ),
      true
    );
  });

  it("rejects unrelated workspaces even with same leaf name", () => {
    assert.equal(
      ideWorkspaceMatchesProject(
        "D:/Other/forensic",
        "D:/Xlab/Forensic/forensic"
      ),
      false
    );
    assert.equal(
      ideWorkspaceMatchesProject(
        "D:/Xlab/AITest",
        "D:/Xlab/Forensic/forensic"
      ),
      false
    );
    assert.equal(
      ideWorkspaceMatchesProject(
        "D:/Xlab/TCONNECT_V2/mobile",
        "D:/Xlab/Forensic/forensic"
      ),
      false
    );
  });

  it("rejects empty sides", () => {
    assert.equal(ideWorkspaceMatchesProject(null, "D:/x"), false);
    assert.equal(ideWorkspaceMatchesProject("D:/x", ""), false);
  });
});

describe("rootsAligned / rootsMismatch (warn helpers)", () => {
  it("normalizeFsRoot collapses separators", () => {
    assert.equal(normalizeFsRoot("D:\\\\a\\\\b\\"), "d:/a/b");
  });

  it("rootsAligned treats missing side as aligned", () => {
    assert.equal(rootsAligned(null, "D:/x"), true);
    assert.equal(rootsMismatch(null, "D:/x"), false);
  });
});
