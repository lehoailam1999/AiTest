# Phase 1 / Phase 2 — Ranh giới & từ vựng (chốt §0)

> Khóa quyết định trước khi rewrite [`ARCHITECTURE_V2_IDE_FIRST.md`](./ARCHITECTURE_V2_IDE_FIRST.md).  
> Backup SoT 2.1: [`archive/ARCHITECTURE_V2_IDE_FIRST_2.1_pre_requirement_studio.md`](./archive/ARCHITECTURE_V2_IDE_FIRST_2.1_pre_requirement_studio.md)

| | |
|--|--|
| **Ngày chốt** | 24/07/2026 |
| **Doc version mục tiêu** | **2.2 (Requirement Studio + Agentic IDE)** |
| **Nguồn bước** | [`REQUIREMENT_STUDIO_DOC_REFACTOR_STEPS.md`](./REQUIREMENT_STUDIO_DOC_REFACTOR_STEPS.md) §0 |

---

## 1. Ranh giới Phase

### Phase 1 — AI Requirement Studio (mở rộng / thay Phase 1 cũ)

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

- **Mục tiêu:** AI hiểu đủ Requirement **trước** khi Generate TC.
- **Không:** Generate TC trực tiếp từ upload / raw file / chat history.
- **Owner kỹ thuật:** Desktop UI + Python API + PostgreSQL + LLM. **IDE Plugin không tham gia.**

### Phase 2 — Agentic IDE Unit (giữ nguyên V2.1)

```text
Approved TC
  → Business Analyzer → Planner ↔ IDE Commands
  → Confidence → Context Packet
  → Generate Unit → Staging → Verify → Apply → Run
```

- **Không đổi** trong đợt Requirement Studio: Bridge, IDE Command Layer, Context Packet, Workspace Apply, BR-V2-01…15 liên quan Unit/IDE.
- Backend **vẫn không** đọc filesystem user cho Unit; chỉ nhận Context Packet.

### Nguyên tắc cutover Phase 1

- **Một flow duy nhất** — xoá / thay “Requirement CRUD → Generate TC”.
- Không để flow cũ và Studio tồn tại song song trong SoT.

---

## 2. Từ vựng bắt buộc (SoT 2.2)

| Term | Nghĩa | Không nhầm với |
|------|--------|----------------|
| **Requirement Workspace** | UI + state làm việc trên Knowledge (Files, Summary, Rules, Chat, Coverage, Freeze) | CRUD một file Requirement kiểu cũ |
| **Knowledge Workspace** | Knowledge đã dựng (rules, actors, APIs, DB summary, …) — **nguồn duy nhất** AI Phase 1 | Raw upload blobs |
| **Requirement Snapshot** | Bản **Freeze immutable**; **input duy nhất** của Generate TC | Draft knowledge / chat log |
| **Document Parser** | Parse + chunk upload | Gửi cả file lên LLM mỗi turn chat |
| **Knowledge Builder** | Chunks → Knowledge structured | Generate TC / Generate Unit |
| **Requirement Coverage** | Đủ/thiếu theo chiều nghiệp vụ (Auth, Validation, …) | Code coverage / test run coverage (Phase 2) |
| **BR-V2-16…21** | Rules Studio (Snapshot, Chat-on-Knowledge, Trace TC↔Snapshot) | BR-V2-01…15 (giữ) |

---

## 3. Versioning tài liệu

| Quyết định | Giá trị |
|------------|---------|
| Bump SoT | **2.1 → 2.2** |
| Title đề xuất | `Architecture Document Version 2.2 (Requirement Studio + Agentic IDE)` |
| Supersedes | V2.1 Agentic IDE Context (cùng path; bản gốc trong `docs/archive/…`) |
| Archive | `docs/archive/ARCHITECTURE_V2_IDE_FIRST_2.1_pre_requirement_studio.md` |

---

## 4. Checklist §0

- [x] Đã nắm cấu trúc SoT 2.1 (§1–§25 + Phụ lục A–C)
- [x] Chốt ranh giới Phase 1 / Phase 2
- [x] Chốt từ vựng
- [x] Chốt bump **2.2**
- [x] Backup SoT vào `docs/archive/`

**Next:** Phase 1 Requirement Studio **R0–R8 complete**. Tiếp Phase 2 (P11+) hoặc harden UX theo feedback.
