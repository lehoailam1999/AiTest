# Kế Hoạch & Kiến Trúc Tự Động Sinh & Chạy Test E2E qua AI CLI Engine (E2E Test Orchestration Plan)

| Thông tin | Chi tiết |
|---|---|
| **Mục tiêu** | Tự động hóa toàn bộ luồng sinh kịch bản E2E, tạo mã test E2E (Playwright / Cypress / Selenium), chạy Headless Sandbox, quay Video / Trace log và đẩy Báo cáo về PostgreSQL DB |
| **Phương thức** | AI CLI Background Conversation Engine (độc lập với IDE) |
| **Framework E2E Hỗ trợ** | Playwright (TS/JS/Python/C#), Cypress (JS/TS), Selenium (Java/Python/C#), Appium (Mobile) |
| **Trạng thái** | Architectural Plan & Technical Specification |
| **SoT triển khai** | [`docs/E2E_TEST_ENGINE.md`](docs/E2E_TEST_ENGINE.md) — Playwright TS MVP, API contract, layout `AItest/E2ETest/` |

---

## 1. Bản Chất của Test E2E & Lý Do Cần AI CLI Orchestrator

Khác với Unit Test (chỉ test 1 hàm/class riêng lẻ), **E2E Test (End-to-End Testing)** mô phỏng **hành vi thực tế của người dùng cuối** di chuyển qua nhiều trang, thao tác UI (click, fill form, drag-drop), tương tác với API và CSDL thật.

### 1.1 Khó khăn lớn nhất khi viết E2E Test bằng tay hoặc qua IDE:
* **Selector dễ bị gãy (Flaky Selectors):** Khi UI thay đổi class CSS hay layout, kịch bản E2E cũ lập tức bị gãy.
* **Tốn thời gian tạo Page Object Model (POM):** Phải viết thủ công các class mô phỏng trang (Pages/Components).
* **Quản lý Môi trường & State phức tạp:** Cần đăng nhập, seed database, dọn dẹp cookies/localStorage trước và sau mỗi test case.
* **Thời gian chạy lâu & Khó debug:** Chạy kịch bản E2E tốn thời gian. Khi fail, Dev/QA phải mò từng screenshot hoặc video để biết gãy ở bước nào.

### 1.2 Lợi Thế Đột Phá Khi Dùng AI CLI Engine Cho E2E Testing:
1. **Tự động sinh Page Object Model (POM):** AI CLI đọc DOM HTML/JSX/Vue/Angular hoặc OpenAPI Spec để tự sinh lớp POM sạch sẽ, tự chọn **Robust Selectors** (`data-testid`, `aria-label`, `role` thay vì CSS class dễ gãy).
2. **Auto-Healing Selector (Tự phục hồi Selector khi UI đổi):** Nếu test fail do không tìm thấy button/input, AI CLI bắt DOM snapshot lúc lỗi, tự tìm selector tương đương mới và cập nhật code test ngầm.
3. **Headless Execution & Artifact Collection:** CLI Engine tự kích hoạt Playwright/Cypress ở chế độ Headless (`npx playwright test`), tự bắt video record, trace.zip, screenshot khi fail để lưu vào PostgreSQL DB.
4. **Đồng bộ kịch bản E2E từ User Journeys / Requirement (PostgreSQL):** Đọc trực tiếp các User Flow đã được QA Approved trong DB để biến thành mã test E2E executable 100%.

---

## 2. Kế Hoạch 5 Bước Triển Khai (5-Phase E2E Execution Plan)

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                         AI CLI E2E Orchestrator                             │
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
 ┌──────────────────────────────────────▼──────────────────────────────────────┐
 │ Phase 1: Requirement & DOM Inspection (Đọc Approved E2E Flows & Page DOM)  │
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
 ┌──────────────────────────────────────▼──────────────────────────────────────┐
 │ Phase 2: Page Object Model (POM) & Test Spec Generation via AI CLI          │
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
 ┌──────────────────────────────────────▼──────────────────────────────────────┐
 │ Phase 3: Environment Setup & Test Data Seeding                              │
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
 ┌──────────────────────────────────────▼──────────────────────────────────────┐
 │ Phase 4: Headless Sandbox Execution & Auto-Healing Selector Loop            │
 └──────────────────────────────────────┬──────────────────────────────────────┘
                                        │
 ┌──────────────────────────────────────▼──────────────────────────────────────┐
 │ Phase 5: Artifact Parsing & Sync to PostgreSQL (Video, Screenshot, HTML)    │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Chi Tiết Từng Phase Trong Plan

### Phase 1: Phân Tích Kịch Bản & Thu Thập DOM / API Spec
* **Đầu vào:** Các **User Journey / Approved E2E Flows** đã lưu trên PostgreSQL (VD: *"Luồng Đăng ký -> Xác nhận OTP -> Đặt hàng -> Thanh toán thành công"*).
* **Cơ chế Inspect:**
  * Nếu ứng dụng đang chạy local (Target App URL): CLI Engine dùng Playwright Chromium ngầm quét DOM tree để trích xuất danh sách các thẻ interactive (`<input>`, `<button>`, `<a>`, `[data-testid]`).
  * Nếu ứng dụng chưa run UI: CLI Engine đọc trực tiếp source code Frontend (React/Vue/Angular) để trích xuất các component & route.

---

### Phase 2: Sinh Code E2E Chuẩn Kiến Trúc Page Object Model (POM)
AI CLI sinh ra cấu trúc file E2E đạt chuẩn doanh nghiệp, chia làm 2 phần riêng biệt:

1. **Page Object Class (`tests/e2e/pages/checkout.page.ts`):** Chứa các selector và hàm thao tác (clickCheckout, fillShippingInfo...).
2. **Test Spec File (`tests/e2e/specs/checkout.spec.ts`):** Chứa kịch bản test thực sự gọi các hàm từ Page Object.

#### Ví dụ Cấu trúc Thư mục E2E Chuẩn (Playwright / Cypress):
```text
e2e/
├── fixtures/            # Test data JSON (Users, Products)
├── pages/               # Page Object Models
│   ├── auth.page.ts
│   └── checkout.page.ts
├── specs/               # Kịch bản E2E Test Cases
│   ├── login.spec.ts
│   └── checkout.spec.ts
├── utils/               # Auth helpers, DB seeder, API mocks
└── playwright.config.ts # File cấu hình Playwright (Headless, Reporters)
```

---

### Phase 3: Quản Lý Môi Trường & Test Data Seeding
* **Auth State Reusability:** Thay vì mỗi test case đều phải đi qua lại màn hình Login, Playwright/Cypress lưu `storageState.json` (cookies, JWT, localStorage) để tái sử dụng token đăng nhập giữa các kịch bản E2E.
* **Database / API Seeder:** CLI Engine gọi script Python/Node ngầm để insert dữ liệu giả mẫu (User test, Sản phẩm test) trước khi kịch bản E2E bắt đầu và dọn dẹp sau khi chạy xong.

---

### Phase 4: Headless Sandbox Execution & Auto-Healing Selector Loop
Đây là điểm khác biệt quan trọng nhất của AI CLI Engine:

1. **Chạy Headless Ngầm:** CLI Engine kích hoạt lệnh `npx playwright test --reporter=json` hoặc `npx cypress run`.
2. **Auto-Healing Selector (Tự sửa Selector khi UI đổi):**
   * Khi 1 step bị `TimeoutError: element not found`:
   * CLI Engine tự động chụp **DOM Tree Snapshot** và **Screenshot** tại thời điểm lỗi.
   * Gửi DOM Snapshot + Selector bị hỏng vào AI CLI với prompt:
     > *"Selector `button#btn-submit-v2` không còn tồn tại trong DOM Snapshot này. Hãy tìm selector mới phù hợp nhất đại diện cho nút Submit Order và cập nhật lại file Page Object."*
   * AI CLI cập nhật selector mới -> CLI Engine cho re-run lại duy nhất kịch bản fail đó (Tối đa 3 lần).

---

### Phase 5: Thu Thập Artifacts & Đồng Bộ Báo Cáo PostgreSQL
Sau khi chuỗi E2E kết thúc, CLI Engine tự động parse kết quả:

* **Báo cáo Tổng hợp:** Tỉ lệ Pass/Fail, thời gian chạy của từng E2E Journey.
* **File Artifacts thu thập được:**
  * Video quay lại toàn bộ màn hình thao tác (`.webm` / `.mp4`).
  * File Trace Playwright (`trace.zip` mở xem timeline chi tiết).
  * Screenshots thời điểm gãy test (`.png`).
* **Đồng bộ DB:** Upload metadata & link lưu trữ video/screenshot lên PostgreSQL DB để hiển thị trên Dashboard cho QA / Project Lead xem.

---

## 4. Ma Trận Framework E2E & Thư Mục Lưu File Chuẩn

| Framework | File Cấu Hình Root | Thư Mục Lưu Page Objects | Thư Mục Lưu Specs | Lệnh Chạy Test Ngầm |
|---|---|---|---|---|
| **Playwright (TS/JS)** | `playwright.config.ts` | `e2e/pages/` | `e2e/specs/` | `npx playwright test --reporter=json` |
| **Playwright (Python)** | `pytest.ini` / `conftest.py` | `tests/e2e/pages/` | `tests/e2e/specs/` | `pytest tests/e2e --browser webkit` |
| **Cypress (JS/TS)** | `cypress.config.ts` | `cypress/e2e/pages/` | `cypress/e2e/specs/` | `npx cypress run --reporter json` |
| **Selenium (Java)** | `pom.xml` | `src/test/java/pages/` | `src/test/java/specs/` | `./mvnw test -Dtest=*E2ETest` |
| **Selenium (Python)** | `pytest.ini` | `tests/pages/` | `tests/specs/` | `pytest tests/e2e` |

---

## 5. Mã Triển Khai Minh Họa Cho E2E Auto-Healing Loop (Python Backend)

```python
import asyncio
import json
import os
from pathlib import Path

class E2EOrchestrator:
    """Orchestrator sinh và điều phối chạy E2E Test với cơ chế Auto-Healing Selectors"""

    def __init__(self, project_root: str, target_url: str):
        self.project_root = Path(project_root)
        self.target_url = target_url

    async def run_e2e_with_auto_healing(self, spec_file: str, cli_runner) -> dict:
        """Kích hoạt Playwright Headless và tự phục hồi khi Selector bị lỗi"""
        cmd = ["npx", "playwright", "test", spec_file, "--reporter=json"]
        max_retries = 3

        for attempt in range(1, max_retries + 1):
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(self.project_root),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode == 0:
                return {"status": "PASSED", "attempts": attempt}

            # Nếu fail -> Bắt trace log và DOM snapshot
            error_output = stdout.decode() + "\n" + stderr.decode()
            
            # Đọc DOM snapshot / trace log gần nhất
            prompt_fix_selector = (
                f"Kịch bản E2E Test tại `{spec_file}` bị lỗi khi chạy.\n"
                f"Log chi tiết:\n```\n{error_output[-2000:]}\n```\n\n"
                f"Hãy phân tích nguyên nhân (đặc biệt nếu do gãy Selector hoặc Element not found), "
                f"sửa lại mã Page Object / Spec và trả về khối code hoàn chỉnh trong ```."
            )

            fixed_code = await cli_runner.send_prompt(prompt_fix_selector)
            
            # Ghi đè file spec/page object đã được sửa
            with open(self.project_root / spec_file, "w", encoding="utf-8") as f:
                f.write(fixed_code)

        return {"status": "FAILED", "attempts": max_retries, "log": error_output}
```

---

## 6. Tóm Tắt Khuyên Dùng Cho Dự Án

1. **Khuyến nghị Framework:** Chọn **Playwright (TypeScript)** làm chuẩn E2E tốt nhất hiện nay vì hỗ trợ native auto-waiting, chụp trace, video, đổi context cực nhanh và tương thích hoàn hảo với AI CLI.
2. **Kiến trúc POM bắt buộc:** Luôn yêu cầu AI CLI tách riêng `Page Objects` và `Test Specs`.
3. **Sandbox CI/CD Ready:** Tự động đẩy kết quả E2E test kèm link Video/Trace log lên PostgreSQL để QA/Lead kiểm duyệt mà không cần bất kỳ thao tác thủ công nào trên IDE.

---

## 7. Triển khai trong AITest (MVP)

Chi tiết product SoT, API contract và happy path Desktop: **[`docs/E2E_TEST_ENGINE.md`](docs/E2E_TEST_ENGINE.md)**.

| Thành phần | Path |
|---|---|
| Orchestrator | `api/app/services/e2e_orchestrator.py` |
| DOM inspect | `api/app/services/e2e_dom_inspector.py` |
| Artifact sync | `api/app/services/e2e_artifact_sync.py` |
| Routes | `api/app/routers/generate_e2e.py` |
| Desktop | `/e2e-test` · `desktop/src/features/e2e-test/` · `desktop/src/lib/e2eWorkspace/` |
