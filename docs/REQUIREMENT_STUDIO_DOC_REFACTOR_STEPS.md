# Phase 1 → AI Requirement Studio — Bước refactor tài liệu Architecture V2.1

| | |
|--|--|
| **Mục tiêu** | Refactor [`ARCHITECTURE_V2_IDE_FIRST.md`](./ARCHITECTURE_V2_IDE_FIRST.md) để Phase 1 trở thành **AI Requirement Studio** (Knowledge → Chat → Freeze → Snapshot → Generate TC) |
| **Phạm vi** | **Chỉ tài liệu kiến trúc** (file này = checklist thực hiện). Không implement code trong bước này. |
| **Giữ nguyên** | Hybrid Desktop + Python + PG + LLM; **toàn bộ Phase 2** (Agent IDE, Generate Unit, Workspace, Bridge) |
| **Nguyên tắc** | Một flow duy nhất — **xoá / thay** flow Phase 1 cũ; không để CRUD Requirement song song với Workspace |
| **Ngày** | 24/07/2026 |
| **Tiến độ** | **R0–R5 DONE** (Upload → Knowledge → Coverage → Chat). Tiếp **R6** Freeze Snapshot. Phase 2 song song **P11**. |

---

## 0. Chuẩn bị (trước khi sửa SoT) — DONE

1. **Đọc SoT hiện tại** — [`ARCHITECTURE_V2_IDE_FIRST.md`](./ARCHITECTURE_V2_IDE_FIRST.md) (mục lục §1–§25 + Phụ lục A–C). ✅
2. **Chốt ranh giới Phase** ✅ — chi tiết trong [`REQUIREMENT_STUDIO_PHASE_BOUNDARY.md`](./REQUIREMENT_STUDIO_PHASE_BOUNDARY.md)
   - **Phase 1 (Requirement Studio):** Upload → Parse → Knowledge → Workspace UI → Chat → Coverage → Freeze → Snapshot → Generate TC → Review → Approve.
   - **Phase 2 (không đụng):** Approved TC → Agent IDE → Generate Unit → Staging → Apply → Run.
3. **Chốt từ vựng (dùng thống nhất trong toàn bộ doc)** ✅

   | Term | Nghĩa |
   |------|--------|
   | Requirement Workspace | UI + state làm việc trên Knowledge (không còn “Requirement CRUD đơn file”) |
   | Knowledge Workspace | Knowledge đã dựng (rules, actors, APIs, …) — nguồn duy nhất cho Chat/Analysis |
   | Requirement Snapshot | Bản Freeze immutable; input duy nhất của Generate TC |
   | Document Parser | Parse + chunk upload; **không** gửi raw file mỗi lần chat |
   | Knowledge Builder | Từ chunks → Knowledge structured |
   | BR-V2-16…21 | Rules mới (xem §5 dưới) |

4. **Quyết định versioning doc** ✅
   - Bump header: `2.1` → **`2.2 (Requirement Studio + Agentic IDE)`**
5. **Backup:** ✅ [`archive/ARCHITECTURE_V2_IDE_FIRST_2.1_pre_requirement_studio.md`](./archive/ARCHITECTURE_V2_IDE_FIRST_2.1_pre_requirement_studio.md)

---

## 1. Cập nhật meta & Mục lục — DONE

| Step | Việc cần làm | Ghi chú |
|------|----------------|---------|
| 1.1 | Sửa bảng đầu file: Version, Ngày, Trạng thái, Supersedes | ✅ 2.2 + archive 2.1 |
| 1.2 | Viết lại **North star** (blockquote đầu) | ✅ Phase 1 Studio + Phase 2 Agent |
| 1.3 | Thêm mục lục §5–§7 (Studio / Knowledge / Snapshot) | ✅ stub sections |
| 1.4 | Đánh số lại mục lục (cũ §5–§25 → §8–§28) | ✅ |

---

## 2. Executive Summary & Business Goals (§1–§2) — DONE

| Step | Việc cần làm |
|------|----------------|
| 2.1 | §1: Thêm bullet **Requirement Studio** | ✅ |
| 2.2 | Bảng “Vấn đề Phase 1 cũ → Thiết kế đúng” | ✅ |
| 2.3 | BG-08…BG-11 | ✅ |
| 2.4 | Giữ BG-01…07 (Phase 2) | ✅ |

---

## 3. System Context & Functional Architecture (§3–§4) — DONE

| Step | Việc cần làm |
|------|----------------|
| 3.1 | C4: Requirement Studio + Knowledge/Snapshot PG | ✅ |
| 3.2 | Upload via Desktop only; không Backend→disk user | ✅ |
| 3.3 | Capability map Studio / Knowledge / Snapshot | ✅ |
| 3.4 | Owner matrix Phase 1 + IDE = — | ✅ |

---

## 4. Technical / Logical Architecture (§5 / SoT §8) — DONE

| Step | Việc cần làm |
|------|----------------|
| 4.1 | Layers + pipeline Phase 1 | ✅ |
| 4.2 | Stack + module `api`/`desktop` | ✅ |
| 4.3 | Sequence Phase 1 + giữ Phase 2 | ✅ (§8.3 / §8.4) |
| 4.4 | Cấm re-read upload blobs for chat | ✅ |

---

## 5. Business Rules (SoT §19) — DONE

| Step | Việc cần làm |
|------|----------------|
| 5.1 | Chèn BR-V2-16…21 | ✅ §19.2 |
| 5.2 | Rà soát / supersede Generate-từ-upload | ✅ §19.3 + §15.3 |
| 5.3 | Cross-ref Studio / sequences | ✅ |

---

## 6. Viết section mới — Phase 1 Architecture (core) — DONE

SoT **§5–§7** đã thay stub bằng nội dung đầy đủ (6.1–6.6). Chi tiết giữ dưới đây làm checklist tham chiếu.

### 6.1 Business Flow (bắt buộc có Mermaid) ✅

```text
Upload Requirement Files
  → Document Parsing
  → Knowledge Builder
  → Requirement Workspace
  → AI Requirement Analysis
  → Interactive Chat
  → Knowledge Update
  → Requirement Snapshot (Freeze)
  → Generate Test Cases
  → Review
  → Approve
```

### 6.2 Module Diagram

Liệt kê + trách nhiệm:

| Module | In | Out | Không làm |
|--------|----|-----|-----------|
| Upload Manager | files đa loại | FileRef[] | LLM |
| Document Parser | FileRef | Chunks + metadata | Chat |
| Knowledge Builder | Chunks | Knowledge Workspace | Generate TC |
| Requirement Workspace UI | Knowledge | edits / chat triggers | IDE commands |
| Coverage Analyzer | Knowledge | Complete/Partial/Missing | Freeze tự ý |
| Chat Orchestrator | Knowledge + user msg | Knowledge delta | Raw file re-ingest (BR-V2-17) |
| Freeze Service | Knowledge + version | Snapshot immutable | Mutate snapshot |
| Generate TC | **Snapshot only** | Draft TCs + snapshotId | Uploaded files |

### 6.3 Supported file types

SRS, BRD, User Story, API Spec, OpenAPI/Swagger, DB Design, Sequence, Flowchart, Excel, MD, PDF, Word — AI **tổng hợp** thành một Knowledge thống nhất.

### 6.4 Knowledge schema (logical)

Business Rules · Actors · Use Cases / Flows · Glossary · API Summary · Database Summary · Constraints · Open Questions · Missing Information · Coverage matrix.

### 6.5 Coverage dimensions

Authentication, Authorization, Validation, Exception, Permission, Notification, Logging, Audit, Performance, Security — status: **Complete | Partial | Missing** + Coverage Dashboard.

### 6.6 Versioning

```text
Draft → (build) → Version N → Chat/Update → Version N+1 → Freeze → Snapshot vN
```

Generate TC luôn gắn Snapshot (không gắn “draft knowledge”).

---

## 7. Đồng bộ các section hiện có — DONE

| Step | Status |
|------|--------|
| 7.1–7.2 | ✅ (trước đó) |
| 7.3 Component Phase 1 | ✅ §10 |
| 7.4 Agent note Snapshot | ✅ §12 |
| 7.5 Generate TC Snapshot | ✅ §15.3 |
| 7.6 Coverage tách tên | ✅ §16.1 / 16.2 |
| 7.7 UI J1 + Studio IA | ✅ §17 |
| 7.8 Responsibility | ✅ §18 |
| 7.9 BR | ✅ §19 |
| 7.10 State machines | ✅ §20 |
| 7.11 Data + API | ✅ §21 |
| 7.12 Security/Error | ✅ §22–23 |
| 7.13 Folder | ✅ §24 |
| 7.14 Migration | ✅ §25 |
| 7.15 Roadmap R0–R8 | ✅ §26 |
| 7.16 Future/Glossary | ✅ §27–28 |
| 7.17 Phụ lục D/E | ✅ |

---

## 8–11. Data / API / diagrams / matrix — DONE (gộp vào §21, §18, Phụ lục D/E)

---

## 12. Roadmap R0–R8 — DONE (§26)

---

## 13. Checklist nghiệm thu tài liệu (Definition of Done)

Trước khi merge SoT / bắt đầu R1:

- [x] Không còn “Upload → Generate TC” làm flow chính
- [x] Generate TC path ghi **Snapshot**
- [x] BR-V2-16…21 trong §19 + cross-ref
- [x] Phase 2 diagrams / BR-V2-01…15 / IDE / Agent không bị xoá
- [x] §15.3, §17 IA, §20, §21, §26, Glossary, Phụ lục D/E
- [x] Requirement Coverage ≠ Code Coverage
- [x] Version header 2.2 + archive 2.1

**R0 = doc SoT merged** — coi như xong khi team accept file này.

---

## 14. Lịch sử làm doc (đã xong)

```text
§0 backup → §1–§5 meta/BR → §6 Studio core → §7–§13 sync + DoD
```

---

## 15. Out of scope (cố ý)

- Không đổi Phase 2 Agent / IDE Command / Context Packet / Workspace Apply  
- Không Backend đọc disk user cho Unit  
- Không để AI đọc lại upload sau khi Knowledge Ready (trừ **Rebuild Knowledge** có chủ đích — audit)  
- R1–R5: **cấm** Generate TC từ upload  

---

**Doc SoT 2.2 = R0 complete.**  
**Next (code):** **R1** — Upload multi-file + `RequirementFile` / FileRef trên PG.  
Tham chiếu: [`ARCHITECTURE_V2_IDE_FIRST.md`](./ARCHITECTURE_V2_IDE_FIRST.md) §5, §8.3, §21, §26.
