# Lộ Trình Triển Khai Theo Từng Phase: Tự Động Sinh Rule (Unit & E2E Test)

> **Mục đích:** Hướng dẫn chi tiết từng công việc (Checklist) chia theo từng Phase để triển khai tính năng **Tự động quét & tự động sinh Bộ Quy tắc (Rules/Conventions)** cho cả **Unit Test** và **E2E Test** khi đẩy đường dẫn Source Code (`bindSourceRoot`).  
> **Ngày cập nhật:** 2026-08-06  

---

## 📍 Phase 0: Tầng Nền Tảng (Foundation — Discover & Auto-Persist)

**Mục tiêu:** Khi gọi `bindSourceRoot(rootPath)`, hệ thống tự động tạo 3 file trong `.ai-test/` của repo đích mà không tốn công người dùng.

### Checklist công việc:
- [x] **0.1. Khai báo TypeScript Types** (`desktop/src/lib/projectProfile/types.ts`):
  - Định nghĩa `ProjectProfile`, `UnitProfile`, `E2EProfile`, `AuthProfile`.
- [x] **0.2. Viết Thuật toán Auto-Discover** (`desktop/src/lib/projectProfile/discoverProjectProfile.ts`):
  - Quét Unit stack (`Jest`, `Vitest`, `Pytest`, `JUnit`, `Mockito`...).
  - Quét E2E stack (`Playwright`, `Cypress`, `data-testid`, `data-cy`...).
  - Quét Route/Controller tạo bảng ánh xạ `moduleMap`.
- [x] **0.3. Viết Engine Render & Ghi File** (`desktop/src/lib/projectProfile/renderConventions.ts`):
  - Render `.ai-test/project.profile.json`.
  - Render `.ai-test/unit-conventions.md`.
  - Render `.ai-test/e2e-conventions.md`.
- [x] **0.4. Tích hợp Tự động vào `bindSourceRoot.ts`** (`desktop/src/lib/workspaceManager/bindSourceRoot.ts`):
  - Móc nối gọi `discoverAndPersistProjectProfile(rootPath)` ngay sau khi chọn thư mục nguồn.

---

## 📍 Phase 1: Nối Luồng Sinh Code Test (Wire Runtime to Read Auto Rules)

**Mục tiêu:** Khi sinh Unit Test hoặc E2E Test, Runner tự động đọc file `.md` quy tắc trong `.ai-test/` gửi sang Backend API.

### Checklist công việc:
- [ ] **1.1. Cập nhật E2E Job Runner** (`desktop/src/lib/e2eWorkspace/e2eJobRunner.ts`):
  - Nạp nội dung từ `.ai-test/e2e-conventions.md`.
  - Gửi kèm tham số `projectRules` trong payload gọi API sinh E2E.
- [ ] **1.2. Cập nhật Unit Job Runner** (`desktop/src/lib/unitWorkspace/index.ts`):
  - Nạp nội dung từ `.ai-test/unit-conventions.md`.
  - Gửi kèm tham số `projectRules` trong payload gọi API sinh Unit.
- [ ] **1.3. Cập nhật API Backend Prompt Injection** (`api/app/routers/generate_e2e.py` & `generate_unit.py`):
  - Nhận `projectRules` và ghép vào System Prompt của LLM trước khi gọi AI sinh code.

---

## 📍 Phase 2: Cài Đặt Quality Gates (Validation & Fail-Closed Guard)

**Mục tiêu:** Đảm bảo mã sinh ra tuân thủ cả **Bộ Rule An toàn Engine** (R6/R9) và **Bộ Rule Tự động Dự án**.

### Checklist công việc:
- [ ] **2.1. Preflight Check (DoR)**:
  - Nếu dự án thiếu cấu hình runner hoặc auth strategy cơ bản, thông báo nhẹ để người dùng kiểm tra lại.
- [ ] **2.2. Bảo vệ `moduleMap` khi re-scan**:
  - Đảm bảo khi bấm quét lại (Rescan), giữ nguyên 100% các tùy chỉnh `moduleMap` do người dùng tự nhập tay.
- [ ] **2.3. Kiểm soát Trần Dung lượng Prompt (Prompt Budget Guard)**:
  - Giới hạn tối đa 2,500 ký tự cho `projectRules` để tránh làm chìm (dilute) chỉ thị của AI.

---

## 📍 Phase 3: Giao Diện Người Dùng & Nút Đồng Bộ (UI & Sync Control)

**Mục tiêu:** Hiển thị minh bạch trạng thái Rule và cung cấp nút bấm "Đồng bộ Profile" chủ động cho người dùng.

### Checklist công việc:
- [ ] **3.1. Thêm nút "Đồng bộ Project Profile" trên UI Desktop**:
  - Đặt tại màn hình thiết lập dự án / E2E Workspace.
  - Cho phép click để chủ động chạy lại Auto-Discover bất cứ lúc nào.
- [ ] **3.2. Hiển thị thông tin tóm tắt**:
  - Hiển thị badge nhỏ: *Runner: Playwright | Unit: Pytest | Locators: data-testid*.

---

## 📍 Phase 4: Kiểm Thử & Tối Ưu (Testing, Observability & Backlog)

**Mục tiêu:** Chạy thử nghiệm thực tế (Smoke test) và tối ưu hóa hiệu năng.

### Checklist công việc:
- [ ] **4.1. Unit Test Suite cho Auto-Discover**:
  - Chạy `npm run test:unit` kiểm tra logic quét và tạo file `.ai-test/`.
- [ ] **4.2. Backend Integration Test**:
  - Chạy `pytest api/tests/` đảm bảo API nhận `projectRules` mượt mà.
- [ ] **4.3. Smoke Test trên dự án thật**:
  - Gắn vào dự án thực tế, kiểm tra chất lượng file test được AI sinh ra (đúng folder, đúng locator, đúng mock library).
