# AITest API — Python

**Stack:** FastAPI + SQLAlchemy + PostgreSQL  
Đây là backend chính thức. Bản Golang cũ đã chuyển sang [`../legacy/golang-api/`](../legacy/golang-api/) — chỉ để tham chiếu contract, không mở rộng milestone mới.

---

## Cách chạy (Windows)

### 1. Điều kiện trước

- Docker Desktop đang bật  
- Python 3.12+ đã cài  

### 2. Setup lần đầu (chỉ chạy 1 lần)

Từ thư mục gốc repo:

```powershell
docker compose up -d postgres
cd api
copy .env.example .env
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 3. Chạy API mỗi ngày

Trong thư mục `api/`:

```powershell
.\run.ps1
```

Hoặc:

```powershell
.\run.bat
```

API lắng nghe: **http://localhost:5000**

### 4. Kiểm tra

| Kiểm tra | URL / lệnh |
|----------|------------|
| Health | http://localhost:5000/health |
| Swagger | http://localhost:5000/docs |
| Login seed | `admin@aitest.com` / `Admin@123` |

---

## Endpoints

| Nhóm | Path | Ghi chú |
|------|------|---------|
| Health | `GET /health` | public |
| Auth | `POST /api/auth/{login,register,refresh}` | public |
| Auth | `GET /api/auth/me`, `POST /api/auth/logout` | Bearer JWT |
| Projects | `GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/{id}` | JWT |
| Connection | `GET/PUT /api/projects/{id}/connection`, `POST .../verify`, `PUT .../status` | JWT |
| Requirements | `GET/POST /api/requirements`, `GET/PUT/DELETE /api/requirements/{id}`, `POST /api/requirements/parse-file` | JWT |
| Sources | `GET/POST /api/projects/{id}/sources`, `GET/DELETE /api/sources/{id}` | JWT |
| Jobs | `POST/GET /api/jobs`, `GET /api/jobs/{id}`, `GET /api/jobs/{id}/context`, `PATCH /api/jobs/{id}` | JWT — worker chạy async trong process |
| Test Cases | `GET/POST /api/testcases`, `POST /api/testcases/bulk`, `.../{id}/{submit,approve,reject}` | JWT |
| Generate Unit | `POST /api/generate-unit` | JWT — chỉ TC Approved |
| Executions | `GET/POST /api/executions`, `GET /api/executions/{id}` | JWT |
| Stubs | `GET /api/dashboard`, `/api/prompts`, `/api/history`, `/api/reports/{projectId}` | JWT |

Toàn bộ response JSON dùng **camelCase**; lỗi trả `{"errors":[...]}`.

---

## Env

File `.env` (copy từ `.env.example`).  
DSN giữ dạng Go: `host=... user=... password=... dbname=... port=5433`.  
CORS mặc định gồm `http://localhost:5173` (React / Tauri).

| Biến | Ý nghĩa |
|------|---------|
| `PORT` | Port API (script mặc định dùng **5000**) |
| `DATABASE_URL` | PostgreSQL (host port **5433** khi chạy docker-compose local) |
| `JWT_KEY` | Secret JWT |
| `CORS_ORIGINS` | Origin cho phép |

---

## Chạy tay (không dùng script)

```powershell
cd api
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --host 0.0.0.0 --port 5000
```

---

## Legacy Golang

Bản Go đã dời sang [`../legacy/golang-api/`](../legacy/golang-api/). Chỉ khi cần đối chiếu hành vi cũ:

```powershell
cd ../legacy/golang-api
go run ./cmd/server
```
