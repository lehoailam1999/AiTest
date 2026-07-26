# TỔNG QUAN KIẾN TRÚC HỆ THỐNG — AI TEST DESKTOP TOOL

| Thông tin | Chi tiết |
|---|---|
| **Tên sản phẩm** | **AI Test Desktop Tool** (Taskide AITest) |
| **Phiên bản** | v11.0 (Cập nhật 07/2026) |
| **Mô hình kiến trúc** | **Hybrid Architecture** (Desktop App + Local FS Bridge + Python REST Backend + PostgreSQL + Multi-LLM Service) |
| **Frontend Desktop** | React 18 (Vite, TypeScript, TailwindCSS / Custom Styling) + Tauri v2 (Rust Native Bridge) |
| **Backend REST API** | Python 3.12 (FastAPI, Uvicorn, Pydantic v2, SQLAlchemy 2.0, Alembic) |
| **Database (SoT)** | PostgreSQL (lưu Dữ liệu người dùng, Dự án, Requirements, Knowledge Base, Test Cases, History) |
| **AI / LLM Engine** | Multi-LLM Adapter System (Support: **Ollama**, **OpenAI**, **Gemini**, **Anthropic**, **Antigravity**) + **Heuristic Fallback Engine** |
| **IDE Plugins** | Extension Module cho VS Code / Antigravity IDE (`ide-plugins/antigravity`) |

---

## 1. Triết Lý & Quy Tắc Thiết Kế Kiến Trúc (Architecture Philosophy)

Hệ thống được thiết kế theo mô hình **Hybrid Desktop & Distributed Backend**:
1. **Desktop App (React + Tauri)**: Đóng vai trò là client chính. Quản lý trải nghiệm người dùng (UX), thao tác trực tiếp trên File System cục bộ của máy tính dev/QA (đọc/ghi file test, spawn process chạy lệnh test như `npm test`, `pytest`, `dotnet test`).
2. **Python Backend (FastAPI)**: Đóng vai trò là Server xử lý nghiệp vụ trung tâm, điều phối AI, phân tích tài liệu, xử lý thuật toán Knowledge Base / Coverage Matrix và giao tiếp với Cơ sở dữ liệu tập trung.
3. **PostgreSQL (Source of Truth)**: Lưu trữ trung tâm các đối tượng dữ liệu như Dự án (`Project`), Không gian làm việc (`Workspace`), Yêu cầu (`Requirement`), Tri thức (`Knowledge`), Kịch bản kiểm thử (`TestCase`), Lịch sử chạy (`ExecutionLog`), và Cấu hình kết nối AI (`AiBackendConnection`).
4. **Heuristic Engine & Fallback Safety**: Khi mạng bị ngắt hoặc dịch vụ LLM không phản hồi (ví dụ: chưa bật Ollama local hay thiếu API Key), hệ thống sẽ **tự động chuyển đổi mượt mà (Graceful Degradation)** sang thuật toán Heuristic nội bộ để không ngắt quãng trải nghiệm của người dùng.

---

## 2. Sơ Đồ Kiến Trúc Tổng Thể (System Architecture)

### 2.1 Mức Khái Niệm (High-Level Architecture)

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                         CLIENT LAYER (Desktop & IDE)                        │
 │  ┌─────────────────────────────────┐   ┌─────────────────────────────────┐  │
 │  │      Desktop App (React 18)     │   │      IDE Plugin (Antigravity)   │  │
 │  │   - Requirement Studio UI       │   │   - Extension Host Bridge       │  │
 │  │   - Test Case Studio UI         │   │   - Direct API Sync             │  │
 │  │   - Code Generator & Execution  │   └─────────────────────────────────┘  │
 │  └────────────────┬────────────────┘                                        │
 │                   │ Tauri IPC (Rust Bridge)                                  │
 │  ┌────────────────▼────────────────┐                                        │
 │  │    Tauri v2 Native Subsystem    │ ───► Local File System (OS)            │
 │  │  - Folder Dialog & Process Spawn│ ───► Run `pytest` / `npm test`         │
 │  └────────────────┬────────────────┘                                        │
 └───────────────────┼─────────────────────────────────────────────────────────┘
                     │ HTTP / REST API (JWT Authenticated)
 ┌───────────────────▼─────────────────────────────────────────────────────────┐
 │                        BACKEND LAYER (Python FastAPI)                       │
 │  ┌───────────────────────────────────────────────────────────────────────┐  │
 │  │                          FastAPI Router Layer                         │  │
 │  │   /api/v1/auth    /api/v1/projects    /api/v1/requirements          │  │
 │  │   /api/v1/chat    /api/v1/testcases   /api/v1/agent                  │  │
 │  └──────────────────┬─────────────────────────────────┬──────────────────┘  │
 │                     │                                 │                     │
 │  ┌──────────────────▼──────────────────┐   ┌──────────▼──────────────────┐  │
 │  │       Knowledge & Coverage          │   │      AI Engine & LLM        │  │
 │  │  - R3 Knowledge Builder             │   │  - Ollama / OpenAI / Gemini │  │
 │  │  - R5 Coverage Matrix Analyzer      │   │  - Antigravity Provider     │  │
 │  │  - Heuristic Engine Fallback        │   │  - Prompt Generator         │  │
 │  └──────────────────┬──────────────────┘   └──────────┬──────────────────┘  │
 └─────────────────────┼─────────────────────────────────┼─────────────────────┘
                       │ SQLAlchemy 2.0 ORM              │ HTTP Client (httpx)
 ┌─────────────────────▼──────────────────┐   ┌──────────▼──────────────────┐
 │       PostgreSQL (Database SoT)        │   │    External / Local LLMs     │
 │ - Users, Projects, Workspaces          │   │ - Ollama (http://127.0.0.1) │
 │ - Documents, Chunks, Knowledge Base    │   │ - OpenAI / Gemini APIs      │
 │ - TestCases, Connections, Logs         │   └─────────────────────────────┘
 └────────────────────────────────────────┘
```

---

## 3. Các Thành Phần Chi Tiết (Component Deep-Dive)

### 3.1 Frontend Client (`desktop/`)
- **Công nghệ**: React 18, Vite 6, TypeScript, TailwindCSS / Custom CSS system.
- **Tauri Native Subsystem (`desktop/src-tauri`)**:
  - Viết bằng **Rust**.
  - Đảm nhiệm việc mở cửa sổ chọn thư mục hệ thống (`tauri-plugin-dialog`).
  - Thao tác tệp trực tiếp (`tauri-plugin-fs`) để đọc mã nguồn người dùng và ghi file test code tự động sinh.
  - Spawn tiến trình HĐH (`tauri-plugin-shell` / `Command`) để thực thi lệnh kiểm thử theo stack dự án (ví dụ: `npm test`, `pytest`, `dotnet test`).

### 3.2 Backend Service (`api/`)
- **Công nghệ**: Python 3.12, FastAPI, Uvicorn, Pydantic v2, SQLAlchemy 2.0 Async/Sync ORM, Alembic.
- **Cấu trúc Module Core**:
  - `app/routers/`: Khai báo các endpoint REST API chính (`auth`, `workspace`, `requirement_studio`, `testcases`, `agent`, `connections`).
  - `app/features/requirement_studio/`:
    - `knowledge_builder.py`: Phân tích đoạn tài liệu (chunks) trích xuất thành đối tượng Knowledge Base (Quy tắc BR, Yêu cầu FR, API spec).
    - `chat_orchestrator.py` & `application.py`: Quản lý hội thoại Requirement Chat, hỗ trợ ghi nhận phản hồi và áp dụng `knowledgeDiff` trực tiếp vào tài liệu.
    - `coverage_analyzer.py`: Tính toán ma trận bao phủ (Coverage Matrix) giữa Yêu cầu (FR) và Test Cases.
  - `app/services/`:
    - `connection_service.py`: Quản lý cấu hình kết nối AI Backend (`AiBackendConnection`), mã hóa/giải mã API Key bằng thuật toán mã hóa AES.
    - `business_analyzer.py`: Phân tích ý định kinh doanh (Business Intent).

### 3.3 AI Engine & Multi-LLM Adapter Layer (`api/app/llm`)
- **Adapter Interface (`Provider`)**: Cho phép cắm rút mở rộng nhiều nhà cung cấp LLM khác nhau.
- **Các Provider hỗ trợ**:
  1. **Ollama**: Chạy model Local (LLaMA 3, Qwen 2.5, DeepSeek...) qua HTTP `http://127.0.0.1:11434`.
  2. **OpenAI**: Gửi request trực tiếp tới API OpenAI (`gpt-4o-mini`, `gpt-4o`).
  3. **Gemini**: Tích hợp Google Gemini (`gemini-2.0-flash`).
  4. **Anthropic**: Tích hợp Claude API (`claude-3-5-haiku`).
  5. **Antigravity**: Provider tùy chỉnh cho hệ sinh thái Antigravity Agentic.
- **Chế độ Heuristic Fallback**: Khi xảy ra sự cố mạng hoặc LLM bị sập, hệ thống chuyển sang chế độ Heuristic nhằm đảm bảo tính sẵn sàng cao (High Availability).

### 3.4 Extension Plugin (`ide-plugins/antigravity`)
- Tích hợp trực tiếp vào VS Code / Antigravity IDE.
- Cho phép lập trình viên vừa xem mã nguồn vừa sinh Test Case và xem ma trận bao phủ ngay trên trình soạn thảo code.

---

## 4. Các Luồng Dữ Liệu & Quy Trình Xử Lý Chính (Core Data Flows)

### 4.1 Luồng Nạp Tài Liệu & Xây Dựng Tri Thức (Requirement -> Knowledge)

```text
User Upload (SRS/Docs) ──► Document Chunker ──► Knowledge Builder (R3)
                                                        │
                                      ┌─────────────────┴─────────────────┐
                                      ▼                                   ▼
                              LLM Structuring                 Heuristic Fallback Engine
                                      │                                   │
                                      └─────────────────┬─────────────────┘
                                                        ▼
                                       Save to PostgreSQL (Knowledge JSON)
```

### 4.2 Luồng Sinh Test Case & Tạo Code Kịch Bản (Generation & Execution)

```text
[Requirement + Knowledge] ──► Test Case Generator (AI Engine) ──► Draft Test Cases
                                                                         │
                                                                   User Review
                                                                         │ Approved
                                                                         ▼
[Test Code Synthesizer] ◄────── Tauri FS Write ◄────── Save Approved TC to DB
           │
           ▼
Write File `.spec.ts` / `.test.py` to User Disk ──► Tauri Process Spawn ──► Run Tests & Return Report
```

---

## 5. Dữ Liệu & Database Schema (Source of Truth)

Dữ liệu lưu giữ trong PostgreSQL bao gồm các bảng chính:
- **`users`**: Lưu tài khoản, vai trò và thông tin xác thực (JWT).
- **`projects` & `workspaces`**: Cấu trúc không gian làm việc của người dùng.
- **`requirements` & `document_chunks`**: Tài liệu yêu cầu phần mềm và các đoạn văn bản đã cắt nhỏ.
- **`knowledge_workspaces`**: Tri thức đã trích xuất (FR, BR, API endpoints, coverage status).
- **`test_cases`**: Danh sách test cases (ID, Title, Steps, Expected Results, Type, Status: Approved/Draft).
- **`ai_backend_connections`**: Lưu thông tin provider AI, URL, Model Name, và Ciphertext API Key.

---

## 6. Tổng Kết Ưu Điểm Kiến Trúc

1. **Bảo mật & Tối ưu hiệu năng**: Không nạp toàn bộ mã nguồn của người dùng lên Server/Database; mã nguồn người dùng nằm an toàn tại máy local và chỉ được đọc bởi Tauri Native Bridge khi cần chạy test.
2. **Không bị khóa phụ thuộc (No Vendor Lock-in)**: Multi-LLM Adapter cho phép chuyển đổi giữa Ollama (Local/Offline) và Cloud LLMs (OpenAI, Gemini) chỉ bằng 1 cú click.
3. **Độ tin cậy cao (High Reliability)**: Hệ thống có bộ fallback Heuristic hoạt động song song, đảm bảo app luôn dùng được kể cả khi mất kết nối Internet hoặc LLM bị quá tải.
4. **Mở rộng dễ dàng (Scalability)**: Tách biệt hoàn toàn giữa UI Client (React/Tauri), API Engine (FastAPI) và Extension Plugin (VS Code/Antigravity IDE).
