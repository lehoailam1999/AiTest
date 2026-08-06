# Kế Hoạch Triển Khai: Tối Ưu Tốc Độ Sinh Code (Context Snapshot · Fine-Grain Job Builder · Queued Oneshot Slots)

> **Mục tiêu:** Tăng tốc độ sinh code Unit & E2E Test **gấp 4 đến 6 lần** (từ 10–15 phút xuống còn **1.5 – 3 phút** cho 50 TCs) bằng luồng **Context Snapshot ➔ Fine-Grain Job Builder ➔ Queued Oneshot Worker Slots**.  
> **Điều kiện tiên quyết (Prerequisite):** Đạt bộ chỉ số ổn định G1–G6 (xem [`E2E_STABILITY_BEFORE_PERF_PLAN.md`](E2E_STABILITY_BEFORE_PERF_PLAN.md)) trước khi kích hoạt Perf Plan.  
> **Ngày cập nhật:** 2026-08-06  
> **Tài liệu tham chiếu:** [`CODEGEN_PERF_BATCH_SNAPSHOT_WORKER_PLAN.md`](CODEGEN_PERF_BATCH_SNAPSHOT_WORKER_PLAN.md), [`AUTO_RULES_PHASED_IMPLEMENTATION.md`](AUTO_RULES_PHASED_IMPLEMENTATION.md).

---

## 1. Mô hình Luồng Kiến trúc Mới (Thứ tự Chuẩn: Snapshot ➔ Builder ➔ Slots)

```text
[ THỨ TỰ THỰC THI CHUẨN XÁC ]

1. Context Snapshot Cache: Nạp đệm ngữ cảnh 1 LẦN theo class (Unit) hoặc featurePath + authRole (E2E)
                         │
                         ▼
2. Fine-Grain Job Builder: Gom theo hạt mịn (Fine Grain) & Trần Token riêng biệt cho từng loại Test
   ├─ E2E Gen : 3 – 5 TCs / Sub-Job (Phân tách Login riêng, không gom chung với Feature)
   └─ Unit Gen: 5 – 8 TCs / Sub-Job (Gom theo class / SUT file)
                         │
                         ▼
3. Queued Oneshot Worker Slots: Đẩy các Sub-Jobs vào 3–5 Slots song song độc lập
   ├─ Mỗi Slot chạy ONESHOT trong _empty_cursor_workspace() ➔ 0% rò rỉ ngữ cảnh (Zero Context Bleeding)
   ├─ Áp dụng Quality Gate / Journey Guard riêng cho từng TC
   └─ Partial Failure ➔ Tự động Retry SOLO độc lập từng TC
```

---

## 2. Giải Quyết 7 Điểm Kỹ Thuật Cốt Lõi

### 2.1. Phân rã theo Hạt mịn (Fine-Grain Grouping)
- **Unit Test**: Gom theo `class_name` hoặc file SUT (`source_file_name`).
- **E2E Test**: Gom theo `featurePath` + `authRole` (+ `storageState`).
- **QUY TẮC VÀNG**: **TUYỆT ĐỐI KHÔNG GOM TEST CASE LOGIN CHUNG VỚI FEATURE!** Các bài test Login luôn chạy Sub-Job riêng hoặc Solo để đảm bảo tính độc lập.

### 2.2. Trần Token & Số lượng TCs Phân biệt theo Loại (Token Budgeting)
- **E2E Test** (do có thêm POM, Spec layout & Locators): Giới hạn an toàn **3 đến 5 TCs / Sub-Job**.
- **Unit Test** (mã gọn hơn): Giới hạn **5 đến 8 TCs / Sub-Job**.

### 2.3. Kỳ vọng SLA Tốc độ Thực tế (Realistic SLA)
- Phản ánh đúng bản chất Oneshot Cold-start (~15–30s / Job): 50 TCs phân rã thành ~10 Sub-Jobs, chạy song song 4 Slots.
- **Kỳ vọng SLA thực tế**: **1.5 đến 3 phút cho 50 TCs** (thay vì 10-15 phút như luồng cũ). Không đặt kỳ vọng ảo 45s làm ảnh hưởng đến các Quality Guards.

### 2.4. Cài đặt các Quality Gates & Fallback Chặt chẽ
1. **Per-TC Guard Enforcement**: Sau khi LLM trả về kết quả Sub-Job, áp dụng `e2e_codegen_guard` và `e2e_journey_enforce` cho **TỪNG Test Case**.
2. **Partial Fail Solo Retry**: Nếu 1 Sub-Job có 1 TC bị lỗi, bóc tách lưu 4 TC thành công, chỉ đưa đúng 1 TC bị lỗi ra **Retry Solo (1 TC / request)**.
3. **Desktop Rules Authoritative**: File `.ai-test/*.md` truyền từ Desktop giữ vai trò SoT tối cao đối với quy định dự án.

---

## 3. Khớp Khởi tạo với Codebase Thực tế

| Tên Module trong Plan cũ | Vị trí Thực tế trong Codebase | Công việc Thực hiện |
| :--- | :--- | :--- |
| `jobBuilder/buildCodegenJobs.ts` | `desktop/src/lib/unitWorkspace/unitCodegenJobBuilder.ts`<br>`desktop/src/lib/e2eWorkspace/e2eCodegenJobBuilder.ts` | Tạo helper gom cụm theo Hạt mịn (`class` cho Unit, `featurePath`+`authRole` cho E2E). |
| `getOrCreateModuleSnapshot` | `desktop/src/lib/codeIndex/contextSnapshot.ts` | Snapshot Key theo `class_name` hoặc `featurePath` + `indexVersion`. |
| `runPool.ts` | `desktop/src/lib/runPool.ts` *(Đã có sẵn)* | Wire Sub-Job queue vào `runPool.ts` hiện có. |
| `session_pool.py` | `api/app/llm/cli/session_pool.py` | Tạo Slot Queue riêng biệt cho Oneshot Codegen (`_empty_cursor_workspace()`), không dùng chung với Interactive Session. |

---

## 4. Lộ trình Triển khai Chuẩn (Snapshot ➔ Builder ➔ Slots)

### 📍 Phase 1: Context Snapshot Cache Engine
- [ ] Implement `contextSnapshot.ts` với Cache Key: `class_name` / `featurePath` + `indexVersion`.

### 📍 Phase 2: Fine-Grain Job Builders & Token Budgeting
- [ ] Implement `unitCodegenJobBuilder.ts` (5–8 TCs / class).
- [ ] Implement `e2eCodegenJobBuilder.ts` (3–5 TCs / featurePath + authRole; Tách biệt Login TCs).

### 📍 Phase 3: Queued Oneshot Slots & Parallel Execution
- [ ] Cấu hình Oneshot Slot Queue độc lập trong `session_pool.py` & `cursor_cli.py`.
- [ ] Wire Sub-Job execution vào `runPool.ts` trên Desktop.

### 📍 Phase 4: Per-TC Guards & Solo Retry Fallback
- [ ] Bóc tách multi-TC output, áp dụng `e2e_codegen_guard` per-TC.
- [ ] Xử lý Partial Failure ➔ Retry Solo cho TC lỗi.

### 📍 Phase 5: Benchmarking & Verification
- [ ] Đo đạc SLA thực tế trên 50 TCs Forensic (Mục tiêu: **1.5 – 3 phút**, 100% PASS Quality Gate G1-G6).
