# AI Test Platform

Công cụ Desktop hỗ trợ QA/Developer sinh Test Case, sinh Unit Test, chạy kiểm thử và tổng hợp kết quả bằng AI, theo kiến trúc **Hybrid**: Desktop (React + Tauri) ↔ Backend (Python FastAPI) ↔ PostgreSQL, với Backend là trung tâm điều phối PostgreSQL và LLM.

**Tài liệu hệ thống tổng hợp (Single Source of Truth):** [`docs/SYSTEM_MASTER_DOCUMENTATION.md`](docs/SYSTEM_MASTER_DOCUMENTATION.md)  
**Tài liệu hướng dẫn & báo cáo triển khai Desktop App:** [`docs/DESKTOP_DEPLOYMENT_GUIDE.md`](docs/DESKTOP_DEPLOYMENT_GUIDE.md)

## Kiến trúc repo

```
AITest/
├── api/                # Backend chính: Python FastAPI + SQLAlchemy
│   └── app/            # config, models, routers, services, llm
├── desktop/            # Desktop App: React (Vite) + Tauri
│   ├── src/            # UI React
│   └── src-tauri/      # Rust commands (filesystem, dotnet test)
├── docs/
├── legacy/             # Code cũ chỉ để tham chiếu
│   ├── angular-frontend/   # Angular SPA (đã thay bằng desktop/)
│   └── golang-api/         # Golang API (đã thay bằng api/)
└── docker-compose.yml
```

## Tech Stack

| Layer | Công nghệ |
|-------|-----------|
| Desktop | React 19 + Vite + Tauri 1 (Rust bridge) |
| Backend | Python 3.12 · FastAPI · SQLAlchemy · JWT |
| Database | PostgreSQL 16 (port host **5433**) |
| AI | LLM Adapter trên Backend: OpenAI / Anthropic / Gemini / Ollama |

## Quick Start

### Prerequisites

- Docker Desktop (cho PostgreSQL)
- Python 3.12+
- Node.js 20+
- Rust + Tauri prerequisites (chỉ cần khi chạy `npm run dev` để build app native)

### Scripts npm (từ thư mục gốc repo)

```powershell
cd D:\Xlab\AITest

# Chạy cả stack (Postgres + API + Desktop — mở thêm 2 cửa sổ)
npm run up

# Hoặc từng phần:
npm run db          # Docker Postgres (host port 5433)
npm run api         # Python API → http://localhost:5088
npm run desktop     # Tauri Desktop (cần API đang chạy)
npm run desktop:ui  # Chỉ Vite UI → http://localhost:5173

# Contract tests P0–P5
npm test
```

Mở **2 terminal** nếu không dùng `npm run up`: một `npm run api`, một `npm run desktop`.

Extension IDE (P1): `npm run extension:install` (cài tự động cho Antigravity IDE, Cursor & VS Code) hoặc `cd ide-plugins/vscode && npm install && npm run compile` / `cd ide-plugins/antigravity && npm install && npm run compile` → F5.

### 1. Database

```powershell
npm run db
# hoặc: docker compose up -d postgres
```

### 2. Backend (Python)

Lần đầu (chỉ 1 lần):

```powershell
cd api
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

Mỗi ngày:

```powershell
npm run api
# Health: http://localhost:5000/health · Swagger: http://localhost:5000/docs
```

Seed user: `admin@aitest.com` / `Admin@123`

### 3. Desktop (React)

```powershell
npm run desktop:install   # lần đầu
npm run desktop           # app native Tauri
# hoặc chỉ UI browser:
npm run desktop:ui
```

`desktop/.env` trỏ `VITE_API_URL=http://localhost:5000/api`.

### Docker (Backend + Postgres)

```powershell
docker compose up -d
# API: http://localhost:5100/health
```

## Core loop

1. Login → 2. Projects (tạo/chọn) → 3. Open Project (trỏ source .NET local qua Tauri) →
4. Settings (kết nối IDE Extension / Cursor CLI) → 5. Requirements → tạo Job Generate →
6. Jobs (poll) → 7. Test Cases (review → Approve) → 8. Generate Unit (ghi file) →
9. Run Test (`dotnet test` → upload execution).

## Default credentials

| Email | Password |
|-------|----------|
| admin@aitest.com | Admin@123 |

## License

MIT
