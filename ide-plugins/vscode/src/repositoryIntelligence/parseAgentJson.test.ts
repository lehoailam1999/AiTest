import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractJsonObjects, lastJsonObject } from "./parseAgentJson";
import { parseSymbolProposal } from "./symbolProposer";

/** Verbatim shape of a real streamed answer: the object arrives twice. */
const DUPLICATED =
  '{"symbols":["CreateEvidenceCommandHandler","Handle"],"paths":["src/A.cs"]}' +
  '{"symbols":["CreateEvidenceCommandHandler","Handle"],"paths":["src/A.cs"]}';

describe("agent JSON extraction", () => {
  it("recovers the answer when the stream repeats the object", () => {
    const proposal = parseSymbolProposal(DUPLICATED);
    assert.deepEqual(proposal.symbols, ["CreateEvidenceCommandHandler", "Handle"]);
    assert.deepEqual(proposal.paths, ["src/A.cs"]);
  });

  it("prefers the last complete copy over a truncated partial", () => {
    const raw = '{"symbols":["Part' + '{"symbols":["Whole"],"paths":[]}';
    assert.deepEqual(parseSymbolProposal(raw).symbols, ["Whole"]);
  });

  it("ignores braces inside string values", () => {
    const objects = extractJsonObjects('{"note":"a } b {","ok":true}');
    assert.equal(objects.length, 1);
    assert.deepEqual(objects[0], { note: "a } b {", ok: true });
  });

  it("reads a fenced object and returns null when there is none", () => {
    assert.deepEqual(lastJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.equal(lastJsonObject("no json here"), null);
  });

  it("keeps nested objects intact", () => {
    const objects = extractJsonObjects('{"outer":{"inner":{"deep":1}}}');
    assert.deepEqual(objects, [{ outer: { inner: { deep: 1 } } }]);
  });

  it("drops invented paths and non-identifier symbols", () => {
    const proposal = parseSymbolProposal(
      '{"symbols":["Valid","not an identifier","Type.Method","Call()"],' +
        '"paths":["C:/abs.cs","../escape.cs","src/ok.cs"]}'
    );
    assert.deepEqual(proposal.symbols, ["Valid", "Method", "Call"]);
    assert.deepEqual(proposal.paths, ["src/ok.cs"]);
  });
});
