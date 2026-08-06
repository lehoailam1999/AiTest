import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { derivePomScaffoldFromTc } from "./derivePomScaffoldFromTc.js";

describe("derivePomScaffoldFromTc", () => {
  it("maps steps into stable page methods", () => {
    const out = derivePomScaffoldFromTc({
      testCase: {
        title: "Them moi vat chung",
        steps: "1. Mo man hinh\n2. Nhap title\n3. Chon status\n4. Luu",
        expectedResult: "Tao moi thanh cong",
      },
      featurePath: "/admin/evidence",
    });
    assert.match(out, /class:\s+ThemMoiVatChungPage/);
    assert.match(out, /featurePath:\s+\/admin\/evidence/);
    assert.match(out, /- gotoFeature/);
    assert.match(out, /- fillTitle/);
    assert.match(out, /- selectStatus/);
    assert.match(out, /- submitForm/);
    assert.match(out, /stepToMethod:/);
    assert.match(out, /2\.\s+Nhap title\s+=>\s+fillTitle/);
  });
});
