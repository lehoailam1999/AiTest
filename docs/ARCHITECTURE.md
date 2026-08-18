# TÀI LIỆU KIẾN TRÚC HỆ THỐNG AITEST PLATFORM (SYSTEM ARCHITECTURE)

> **Tài liệu Kỹ thuật Tổng quan về Kiến trúc, Pipeline và Dữ liệu**  
> **Dự án:** AITest Platform — Nền tảng AI Hỗ trợ Kiểm thử Tự động  
> **Phiên bản:** 2.0.0 (Thuần Việt & Chuẩn hóa Pipeline)  
> **Ngày cập nhật:** 13/08/2026  

---

## MỤC LỤC TỔNG QUAN

1. [Tóm Tắt Điều Hành](#1-tóm-tắt-điều-hành)
2. [Sơ Đồ Kiến Trúc Hệ Thống](#2-sơ-đồ-kiến-trúc-hệ-thống)
3. [Pipeline — Unit và E2E Test](#3-pipeline--unit-và-e2e-test)
4. [Pha Phê Duyệt & Gắn Mã (Approve / Ground)](#4-pha-phê-duyệt--gắn-mã-approve--ground)
5. [Pha Sinh Mã Tự Động (Automate Phase)](#5-pha-sinh-mã-tự-động-automate-phase)
6. [Kiến Trúc Dữ Liệu & Cấu Trúc File System](#6-kiến-trúc-dữ-liệu--cấu-trúc-file-system)
7. [Bảo Mật & Chiến Lược Triển Khai](#7-bảo-mật--chiến-lược-triển-khai)
8. [Các Quyết Định Kiến Trúc Chính (ADR)](#8-các-quyết-định-kiến-trúc-chính-adr)
9. [Giới Hạn Hệ Thống & Phạm Vi Ngoài Mục Tiêu](#9-giới-hạn-hệ-thống--phạm-vi-ngoài-mục-tiêu)

---

## 1. TÓM TẮT ĐIỀU HÀNH

Luồng vận hành cốt lõi của AITest Platform:  
**Tải Yêu cầu (SRS) → Phân tích → Sinh & Duyệt Test Case → Gắn mã nguồn SUT (Ground) → Sinh code & Xác minh (Unit / E2E).**

Mã nguồn SUT là **Stack-Agnostic** (không phụ thuộc ngôn ngữ, hỗ trợ C#, TypeScript/JavaScript, Python...). Hệ thống hỗ trợ tốt nhất và tối ưu sâu cho **C# (.NET)** và **TypeScript/JavaScript**.

| Tầng thành phần | Công nghệ sử dụng | Vai trò & Đặc điểm |
|---|---|---|
| **Desktop App** | React 19, Vite, TypeScript, Tauri v1 (Rust) | Giao diện Native siêu nhẹ (~15MB), thao tác File System local SUT, điều phối chạy test. |
| **Backend API** | Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2 | Quản lý Auth, Requirement Studio, Test Cases (SoT), Jobs Dispatcher & Coverage Metrics. |
| **Database** | PostgreSQL 16 (Port host mặc định **5433**) | Trung tâm lưu trữ duy nhất (Single Source of Truth - SoT) cho dữ liệu nghiệp vụ. |
| **IDE Extension** | Extension `aitest-ide` (Cursor / VS Code) | Plugin kết nối Desktop App với Cursor Agent CLI qua giao thức JSON-RPC WebSocket. |
| **Giao thức dùng chung** | `@aitest/ide-protocol` | Hợp đồng giao tiếp giữa Desktop App và IDE Extension. |
| **Động cơ AI CLI** | Cursor Agent CLI (chạy local trên SUT) | **Tầng AI Duy Nhất**: Sinh code Unit Test và E2E Test trực tiếp trong thư mục local SUT. |

---

## 2. SƠ ĐỒ KIẾN TRÚC HỆ THỐNG

Người dùng QA / Dev thao tác trực tiếp trên **AITest Desktop App**. 
Cả hai quy trình sinh **Unit Test** và **E2E Test** đều dùng **chung một luồng sinh mã (Gen Owner = IDE Extension → Agent CLI local)**; chỉ khác nhau ở các marker đầu vào và bộ thực thi xác minh (Runner Verify) đầu ra.

```mermaid
sequenceDiagram
  actor QA as Người dùng QA/Dev
  participant D as Desktop App
  participant B as Backend API
  participant E as IDE Extension
  participant CLI as Cursor Agent CLI
  participant S as Mã nguồn SUT (Local)

  QA->>D: Thao tác Studio / Duyệt TC / Bấm Sinh Code
  D->>B: Phân tích · Tạo Jobs TC · Lọc Shortlist
  B-->>D: Danh sách TC Đã Duyệt (Approved)
  D->>S: Quét Index · Đồng bộ file Markdown .ai-test/
  D->>E: Kết nối IDE -> Gửi lệnh Gen Unit hoặc E2E
  E->>CLI: Khởi chạy CLI (cwd = Thư mục SUT local)
  CLI-->>E: Trả về mã nguồn test đã sinh
  E-->>D: Phản hồi tệp kết quả
  D->>S: Ghi Staging → Tự chạy Verify → Apply vào AItest/
```

---

## 3. PIPELINE — UNIT VÀ E2E TEST

Một quy trình khép kín xuyên suốt 3 pha chính: **Thiết Kế (Design) → Gắn Mã (Ground) → Sinh Tự Động (Automate)**. 
Sau khi kịch bản Test Case được phê duyệt (Approved): **cả Unit và E2E dùng chung một Động cơ Sinh Mã (Extension + Agent CLI)**; chỉ khác nhau ở dữ liệu gắn mã (Ground SoT), định dạng marker, thư mục lưu kết quả (Apply) và bộ chạy xác minh (Runner Verify).

```mermaid
flowchart TB
  SRS[Tải lên SRS / Yêu cầu] --> Know[Phân tích]
  Know --> Jobs[Sinh test case]
  Jobs --> Draft[Kịch bản Nháp - Draft TCs]
  Draft --> Review[Review]
  Review --> Approved[Kịch bản Đã Duyệt - Approved TCs]

  Approved --> Ground{Phân loại Test Case}

  Ground -->|Unit Test| UG[Gắn mã Unit: IDE Repository Intelligence]
  UG -->|authoritative decision| UMD["AItest/test-cases/UnitTest: MD + .grounding.json"]
  UMD --> Gen["Consume-only Gen: Extension → Agent CLI"]
  Gen --> UVA["Tool draft (OS temp) → Verify tạm → khôi phục source → Update"]
  UVA --> UOut[Lưu vào AItest/UnitTest]

  Ground -->|E2E Test| EG[Gắn mã E2E: FE Catalog + Auth]
  EG --> EMD["Tệp MD: path / featurePath / authRole"]
  EMD --> Gen
  Gen --> EVA[Staging → Verify → Apply]
  EVA --> EOut[Lưu vào AItest/E2ETest]
```

### Bảng Phân Tách Trách Nhiệm Giữa Các Pha:

| Pha | Đơn vị Đảm nhận | Đầu vào ──► Đầu ra |
|---|---|---|
| **1. Thiết Kế (Design)** | Backend + PostgreSQL | SRS → Phân tích → Sinh TC Approved (**chưa** gắn path SUT) |
| **2. Gắn Mã (Ground)** | **IDE Repository Intelligence** (+ Desktop persist) | Approved TC ──► immutable decision ──► MD markers + companion `.grounding.json` |
| **3. Sinh Code (Automate)** | **IDE Extension + Agent CLI** | Unit: Approved MD ──► draft nội bộ Tool ──► Verify tạm ──► Update ghi `AItest/UnitTest`; E2E giữ pipeline riêng. |

### So Sánh Chi Tiết Giữa Unit Test Và E2E Test:

| Tiêu chí | Unit Test | E2E Test (Playwright) |
|---|---|---|
| **Luồng Sinh Code** | Desktop ──► Extension ──► Agent CLI | **Cùng luồng** Desktop ──► Extension ──► Agent CLI |
| **Đối tượng Gắn (Ground)** | Class Handler / DTO / Hàm Backend | Đường dẫn Route FE + Vai trò Đăng nhập (Auth Role) |
| **Cú pháp Marker** | `path:`, `code:`, `target.property:` | `path:` / `featurePath:`, `authRole:` |
| **Bộ chạy Xác minh (Verify)** | `dotnet test` / `vitest` / `jest` / `pytest` | Playwright Runner (`workers: 1`) |
| **Thư mục Đầu ra (Apply)** | `AItest/UnitTest/{Module}/` | `AItest/E2ETest/_shared/` + `{Req}/{TC}/` |
| **Xác thực (Auth Mode)** | Không yêu cầu | `storage` \| `ui_helper` \| `none` \| `public` |

---

## 4. PHA PHÊ DUYỆT & GẮN MÃ (APPROVE / GROUND)

Khi tạo Jobs sinh Test Case ở pha Design, hệ thống **tuyệt đối không ghi cứng đường dẫn mã nguồn (SUT Path)** vào CSDL PostgreSQL. Chỉ khi người dùng bấm **Duyệt (Approve)** trên Desktop App, quá trình gắn mã (Grounding) mới được kích hoạt:

- **Dành cho Unit Test**: Desktop gọi IDE `unitApproveResolve` (Repository Intelligence: symbols/source/evidence) ──► khóa `UnitApprovalDecision` ──► project `path:`/`code:`/`target.property` + companion `.grounding.json`. Gen **consume-only**; không fallback `index.db` / disk re-resolve. Chi tiết: [`docs/UNIT_APPROVE_SOURCE_GROUNDING.md`](UNIT_APPROVE_SOURCE_GROUNDING.md).
- **Dành cho E2E Test**: Hệ thống đối chiếu Frontend Catalog + `project.profile.json` + `.ai-test/auth/` ──► Gắn thẻ `path:`, `featurePath:` và `authRole:` chuẩn xác (không tự bịa ra route hoặc vai trò đăng nhập không tồn tại).

---

## 5. PHA SINH MÃ TỰ ĐỘNG (AUTOMATE PHASE)

**Luồng Unit:** `AItest/test-cases/UnitTest/*.md ──► Gates ──► Extension + Agent CLI ──► draft nội bộ Tool (OS temp) ──► Verify tạm ──► khôi phục source ──► người dùng Update/Apply vào AItest/UnitTest`.

```mermaid
flowchart TB
  MD[Tệp Approved MD] --> Gates{Cổng Kiểm Tra Gates}
  Gates -->|Hợp lệ (OK)| Ext["Extension → Agent CLI"]
  Gates -->|Không hợp lệ| X[Từ chối Sinh Code]
  Ext --> Stg[Draft nội bộ Desktop Tool / OS temp]
  Stg --> Ver{Stage tạm → chạy Verify → restore source}
  Ver -->|Unit Test| RU[Động cơ: dotnet / vitest / jest / pytest]
  Ver -->|E2E Test| RE[Động cơ: Playwright]
  RU --> App[Người dùng Update/Apply → AItest/UnitTest]
  RE --> App
```

| Bước Thực Thi | Unit Test | E2E Test |
|---|---|---|
| **Cổng Kiểm Tra (Gates)** | Kiểm tra kết nối IDE; field bind; Planner `ready`. | Kiểm tra kết nối IDE; route / `authRole` đã được ground. |
| **Sinh Code (Gen)** | Agent CLI chạy trên thư mục SUT local. | **Cùng** Agent CLI chạy trên thư mục SUT local. |
| **Lưu nháp** | OS temp của Desktop Tool; không tạo `.ai-test/staging` trong source | Pipeline E2E riêng |
| **Xác minh & Ghi chính thức** | Verify chỉ stage tạm rồi restore; nút Update/Apply mới ghi `AItest/UnitTest/` | Chạy Playwright ──► Ghi vào `AItest/E2ETest/` |

---

## 6. KIẾN TRÚC DỮ LIỆU & CẤU TRÚC FILE SYSTEM

### 6.1 Mô Hình CSDL PostgreSQL (SoT Nghiệp Vụ)

```mermaid
erDiagram
  NGUOIDUNG ||--o{ DUAN : "sở hữu"
  DUAN ||--o{ KHONGGIAN_YEUCAU : "chứa"
  DUAN ||--o{ KETNOI_AI_BACKEND : "cấu hình"
  KHONGGIAN_YEUCAU ||--o{ TEP_YEUCAU : "bao gồm"
  KHONGGIAN_YEUCAU ||--o{ KHONGGIAN_TRI_THUC : "xây dựng"
  KHONGGIAN_YEUCAU ||--o{ SNAPSHOT_SOT : "chụp ảnh"
  SNAPSHOT_SOT ||--o{ KICHBAN_TESTCASE : "sinh ra"
  KICHBAN_TESTCASE ||--o{ TIEN_TRINH_JOB : "thực thi"
  DUAN ||--o{ BAO_CAO_COVERAGE : "theo dõi"
```

> [!NOTE]
> PostgreSQL chỉ đóng vai trò lưu trữ duy nhất (SoT) cho dữ liệu nghiệp vụ (Yêu cầu, Test Case, Trạng thái Jobs). CSDL **không lưu trữ mã nguồn dự án SUT hay các tệp binary video/trace nặng**.

### 6.2 Cấu Trúc Unit Test Trên Source

```text
{Thư_Mục_Mã_Nguồn_SUT_Local}/
├── AItest/                             ← Một cây thao tác Unit trên source
│   ├── test-cases/
│   │   └── UnitTest/{module}/
│   │       ├── TC-001.md               ← Kịch bản Approved
│   │       └── TC-001.grounding.json   ← Quyết định IDE authoritative
│   ├── UnitTest/{module}/…             ← Mã Unit Test đã Update/Apply
│   ├── E2ETest/_shared/… + {Req}/{TC}/ ← Mã nguồn E2E Test Playwright (*.spec.ts)
│   ├── APITest/ · IntegrationTest/     ← Cấu trúc dành cho API / Integration Test
│   └── Reports/ · Coverage/ · Metadata/← Báo cáo kết quả kiểm thử & bao phủ
└── .ai-test/                           ← Chỉ metadata/profile local; không chứa Unit draft
    ├── project.profile.json
    ├── unit-conventions.md
    ├── code-aliases.json
    └── logs/                           ← debug best-effort, gitignored
```

Thao tác **Sửa/Xóa** trên Tool chỉ đổi draft. Sau Verify, source được trả về đúng trạng
thái trước đó. Nút **Update/Apply** là ranh giới duy nhất ghi đè hoặc xóa file dưới
`AItest/UnitTest/`. Trang **Run Test** luôn chạy bản đã Update trong source.

### 6.3 Cách Chạy Unit Test

1. **Approve TC**: tạo/cập nhật `AItest/test-cases/UnitTest/{module}/{TC}.md`
   và file `.grounding.json` bên cạnh.
2. **Gen Unit**: Tool đọc Approved TC, Extension sinh code vào Tool draft.
3. **Sửa/Xóa trên Tool**: chỉ thay đổi draft; cần Verify lại sau mỗi lần sửa.
4. **Verify**: Tool stage tạm, chạy runner, rồi restore source dù PASS hay FAIL.
5. **Update source**: khi PASS, bấm **Update** để ghi/xóa dưới `AItest/UnitTest`.
6. **Run Test**: chạy từ trang Run Test, hoặc chạy trực tiếp trong source:
   - C#: `dotnet test "AItest/AItest.UnitTests.csproj" --nologo`
   - TypeScript/Jest: `npx jest --config "AItest/jest.config.cjs" --runInBand`

Muốn chỉnh lại sau khi đã Update: sửa TC hoặc Gen lại trên Tool → sửa draft → Verify
→ Update lần nữa. Tool nhận biết file đã tồn tại và thực hiện update thay vì tạo bản
trùng.

| Stack Mã Nguồn SUT | Định dạng Code Đầu ra (Unit) | Bộ Chạy Test Runner |
|---|---|---|
| **C# (.NET / `.csproj` / `.sln`)** | `*.cs` | `dotnet test` |
| **TypeScript / JS (`package.json`)** | `*.test.ts` / `*.spec.ts` | `vitest` / `jest` |
| **Python (`pytest`)** | `test_*.py` | `pytest` |

---

## 7. BẢO MẬT & CHIẾN LƯỢC TRIỂN KHAI

| Ranh giới Bảo mật | Cơ chế Bảo vệ |
|---|---|
| **Người dùng ↔ Backend API** | Xác thực qua **JWT Token**; Cấu hình CORS chặt chẽ. |
| **Kết nối AI CLI Engine** | Thực thi trực tiếp trên máy cá nhân qua Cursor CLI / Claude CLI; **không hardcode vendor API Key**. |
| **Ghi đĩa Local SUT** | TC + code Unit chỉ ghi dưới `AItest/`; draft Gen nằm trong OS temp của Tool. |
| **Thông tin Đăng nhập E2E** | Sử dụng file seed/profile local trên máy cá nhân — không invent; không lưu trữ mật khẩu nhạy cảm lên CSDL Backend. |

```text
[MÁY CHỦ DOANH NGHIỆP] ──► PostgreSQL + FastAPI Backend (Quản lý Auth, Requirement, SoT Test Cases)
          ▲
          │ (JWT / HTTP)
          ▼
[MÁY QA / DEV LOCAL]  ──► AITest Desktop App + IDE Extension + Cursor Agent CLI (Xử lý mã local 100%)
```

---

## 8. CÁC QUYẾT ĐỊNH KIẾN TRÚC CHÍNH (ADR)

| Mã ADR | Quyết định Kiến trúc | Lý do & Ý nghĩa |
|---|---|---|
| **ADR-1** | **Hybrid Desktop + API + Extension** | Đảm bảo SoT nghiệp vụ tập trung trên Server nhưng sinh code an toàn 100% trên File System local. |
| **ADR-2** | **Gen Owner = IDE Extension + Agent CLI** | Sử dụng **cùng một luồng sinh code duy nhất** cho cả Unit Test và E2E Test. |
| **ADR-3** | **Phân biệt Unit vs E2E qua Runner** | Unit và E2E chỉ khác nhau ở cú pháp marker, thư mục đầu ra và runner xác minh; không đổi Động cơ sinh code. |
| **ADR-4** | **Tách rời 3 Pha (Design / Ground / Automate)** | Tránh hiện tượng AI tự bịa ra đường dẫn file mã nguồn không tồn tại khi viết kịch bản. |
| **ADR-5** | **AI Approve theo danh sách Shortlist** | Chống hiện tượng ảo giác (Hallucination) của AI khi chọn class/method kiểm thử. |
| **ADR-6** | **Fail-Closed Security** | Nếu thông tin ranh giới không hợp lệ, hệ thống từ chối sinh code ngay lập tức thay vì ghi nhầm file. |
| **ADR-7** | **Chỉ mục mã nguồn Local (`index.db`)** | Tệp chỉ mục gọn nhẹ lưu trực tiếp tại máy local giúp tra cứu symbol nhanh chóng. |
| **ADR-8** | **Giao thức `@aitest/ide-protocol` Độc Lập** | Giữ giao thức kết nối sạch sẽ, không nhét từ điển sản phẩm nghiệp vụ vào protocol. |
| **ADR-9** | **Xác minh 100% Pass trước khi Apply** | Chỉ khi bộ test runner chạy PASS 100% tại thư mục tạm Staging thì mới di chuyển chính thức vào `AItest/`. |
| **ADR-10**| **Tự động Sửa Lỗi Kịch bản (E2E Auto-Heal)** | Tự động phát hiện và điều chỉnh lại Selector UI khi cấu hình DOM giao diện thay đổi. |

---

## 9. GIỚI HẠN HỆ THỐNG & PHẠM VI NGOÀI MỤC TIÊU

### 1. Giới hạn Hệ thống Hiện tại (Current Limitations)
- **Chỉ mục C#**: Hiện tại đồ thị phụ thuộc (Import Graph) của C# sử dụng giải thuật tĩnh, chưa phân tích sâu bằng TypeScript.
- **API / Integration Test Engine**: Cấu trúc thư mục `AItest/APITest/` và `AItest/IntegrationTest/` đã được quy hoạch khung, nhưng động cơ sinh tự động đang ưu tiên 2 luồng chính là **Unit Test** và **E2E Test**.

### 2. Các Mục Tiêu Ngoài Phạm Vi (Non-Goals)
- Hệ thống **không thay thế hệ thống quản lý mã nguồn Git / CI/CD** của dự án SUT.
- Giao thức IDE Bridge **không lưu trữ hay tích lũy dữ liệu nhạy cảm** của doanh nghiệp.
- Ứng dụng Desktop **không chứa bất kỳ bộ chìa khóa bí mật (Hardcoded Private Keys/API Keys)** nào.

---

> **Tài liệu được lưu trữ trực tiếp tại:** [`docs/ARCHITECTURE.md`](file:///d:/Xlab/AITest/docs/ARCHITECTURE.md)  
> **Áp dụng cho:** Đội ngũ Phát triển Hệ thống, Kiến trúc sư Phần mềm (Architect) và Đội ngũ Vận hành AITest Platform.
