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

  it("maps checkbox tick steps to toggleCheckbox (not selectOption)", () => {
    const out = derivePomScaffoldFromTc({
      testCase: {
        title: "Digital evidence toggle",
        steps:
          "1. Tick chọn checkbox Vật chứng kỹ thuật số\n2. Quan sát vùng hiển thị các trường\n3. Không tick rồi tick lại",
        expectedResult: "Hiển thị trường mô tả thiết bị",
      },
      featurePath: "/admin/evidence",
    });
    assert.match(out, /- toggleCheckbox/);
    assert.match(out, /- expectExpectedState/);
    assert.doesNotMatch(out, /- selectOption/);
    assert.doesNotMatch(out, /- submitForm/);
  });

  it("injects openCreateForm when precondition requires popup", () => {
    const out = derivePomScaffoldFromTc({
      testCase: {
        title: "Digital evidence toggle",
        precondition: "Đã mở popup tạo mới vật chứng",
        steps: "1. Tick chọn checkbox Vật chứng kỹ thuật số",
        expectedResult: "Hiển thị trường mô tả thiết bị",
      },
      featurePath: "/admin/evidence",
    });
    assert.match(out, /- openCreateForm/);
    assert.match(out, /\[precondition\].*openCreateForm/);
    assert.match(out, /- toggleCheckbox/);
  });
});
