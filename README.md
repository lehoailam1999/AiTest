# AITest Platform

Quản lý & sinh mã kiểm thử (Unit / E2E) cho QA & Developer.

| Thành phần | Stack |
| :--- | :--- |
| **Desktop** | React 19 + Vite 6 + Tauri 1.6 |
| **API** | Python 3.12 + FastAPI + SQLAlchemy 2 + Alembic |
| **DB** | PostgreSQL 16 (Docker) |
| **IDE bridge** | Extension `aitest-ide` (Cursor / VS Code / Antigravity) + AI CLI (Cursor Agent / Gemini / Claude / …) |

---

## 1. Yêu cầu trên máy

| Công cụ | Kiểm tra | Bắt buộc? |
| :--- | :--- | :--- |
| **Node.js 20+** | `node -v` | Có |
| **Python 3.12+** | `python --version` | Có (API native) |
| **Docker Desktop** | `docker compose version` | Có (Postgres) |
| **Rust 1.70+** | `rustc --version` | Có (chạy / build Desktop Tauri) |
| **Cursor / VS Code / Antigravity** | — | Có nếu dùng Unit / E2E Gen từ IDE |
| **AI CLI** (vd. Cursor `agent`) | Cài + đăng nhập trong **Desktop → Cấu hình AI** | Khi sinh mã bằng CLI |

`npm run setup` và `npm run up` hiện là **PowerShell (Windows)**. Linux/macOS dùng [Cách 2](#3-cài--chạy-toàn-stack) thủ công.

---

## 2. Cài thư viện BE & FE

Làm **một lần sau clone** (hoặc khi `requirements.txt` / `package.json` đổi). Từ **root repo**.

### Backend (API — Python)

Nguồn phụ thuộc: [`api/requirements.txt`](api/requirements.txt) (FastAPI, SQLAlchemy, Alembic, …).

```powershell
cd api
Copy-Item .env.example .env -ErrorAction SilentlyContinue   # lần đầu

python -m venv .venv
.\.venv\Scripts\Activate.ps1          # Linux/macOS: source .venv/bin/activate

python -m pip install -U pip
pip install -r requirements.txt
```

Windows (không cần activate, từ root):

```powershell
api\.venv\Scripts\python.exe -m pip install -U pip
api\.venv\Scripts\python.exe -m pip install -r api\requirements.txt
```

### Frontend (Desktop UI + protocol)

| Gói | Thư mục | Lệnh từ root |
| :--- | :--- | :--- |
| IDE protocol (shared) | `packages/ide-protocol` | `npm install --prefix packages/ide-protocol` |
| Desktop (React / Vite / Tauri) | `desktop` | `npm install --prefix desktop` |

```powershell
npm install --prefix packages/ide-protocol
npm install --prefix desktop
```

Rust crate của Tauri (`desktop/src-tauri`) được `cargo` kéo khi chạy `npm run desktop` / `desktop:build` — không cần `pip`/`npm` riêng cho phần đó.

### Gộp một lệnh (Windows)

```powershell
npm run setup
# = Postgres Docker + venv + pip install -r requirements.txt + alembic
#   + ide-protocol + desktop npm install (+ thử extension)
```

Chỉ cài lib, bỏ extension: `npm run setup:no-ext`.

---

## 3. Cài & chạy toàn stack

Mọi lệnh từ **thư mục gốc repo** (nơi có `package.json` + `docker-compose.yml`).

### Cách 1 — Windows (khuyên dùng)

```powershell
git clone <repo-url> AITest
cd AITest

# Lần đầu (đã gồm cài lib BE + FE ở mục 2)
npm run setup

# Mỗi lần làm việc: Postgres → migrate → mở cửa sổ API (:8000) + Desktop Tauri
npm run up
```

### Cách 2 — Từng bước (sau khi đã cài lib ở mục 2)

**1) Postgres**

```bash
npm run db
# host :5433 → container :5432
```

**2) API**

```bash
cd api
# .venv + pip đã làm ở mục 2
alembic upgrade head

# Dev (reload) — port 8000, khớp api/.env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Từ root (Windows, đã có `api/.venv`):

```powershell
npm run api
```

**3) Desktop** (terminal khác, từ root — `node_modules` đã có sau mục 2)

```bash
npm run desktop
```

**4) IDE Extension** (sau khi Desktop chạy)

Ưu tiên trong app: **Dự án → Sửa / Tạo → Connect IDE → Cài Extension** (tool tự cài `.vsix` qua CLI IDE khi có thể).

Fallback thủ công:

```powershell
npm run extension:install
```

Mở đúng **folder source** của project trong Cursor / VS Code / Antigravity. Status bar hiện `AITest :port` và Desktop tự kết nối. Nếu chỉ copy thư mục (không qua CLI), cần **Developer: Reload Window**.

**5) AI CLI**

Trong Desktop → **Cấu hình AI**: chọn CLI → tool hướng dẫn cài / đăng nhập nếu thiếu → **Lưu & Test CLI** đến khi Ready.

---

## 4. URL & tài khoản

| | |
| :--- | :--- |
| Health | http://localhost:8000/health |
| Swagger | http://localhost:8000/docs |
| Admin seed | `admin@aitest.com` / `Admin@123` |
| Đăng ký | màn hình Register trên Desktop |

`api/.env` (tạo từ `.env.example`): Postgres `localhost:5433`, API `PORT=8000`. Desktop dev gọi `http://127.0.0.1:8000/api`.

Full Docker (Postgres + API container): `docker compose up -d --build` → API host **:8000**. Schema vẫn nên `npm run db:up` trên máy có venv (xem [`api/README.md`](api/README.md)).

---

## 5. Database (migrate)

Postgres phải đang chạy (`npm run db`):

```powershell
# Sửa model trong api/app/models/domain.py
npm run db:migrate   # upgrade head + gen file versions/
# Kiểm tra SQL trong file mới
npm run db:up        # áp vào DB
npm run db:status
```

DB trống lần đầu: `db:up` bootstrap schema từ model rồi stamp head.

---

## 6. Build Desktop installer

```powershell
# Endpoint API lúc build (bake vào UI) — một lệnh: cài protocol + desktop deps rồi đóng gói MSI
$env:VITE_API_URL = "http://<IP_HOẶC_HOST>:8000/api"
npm run desktop:build
```

`desktop:build` tự cài `packages/ide-protocol` + `desktop` rồi `tauri build`.

Output: `desktop/src-tauri/target/release/bundle/msi/` (Windows). Chi tiết deploy: [`docs/DESKTOP_DEPLOYMENT_GUIDE.md`](docs/DESKTOP_DEPLOYMENT_GUIDE.md).

---

## 7. Script npm (root)

| Lệnh | Việc |
| :--- | :--- |
| `npm run setup` | Lần đầu: Docker Postgres, **pip BE**, migrate, **npm FE** (+ thử extension) |
| `npm run setup:no-ext` | Như trên, bỏ extension |
| `npm run up` / `dev` | Postgres + migrate + API + Desktop (cửa sổ mới) |
| `npm run db` / `db:down` | Bật / dừng Postgres |
| `npm run db:up` | `alembic upgrade head` (DB trống → bootstrap) |
| `npm run db:migrate` | Autogen file migration mới |
| `npm run db:status` / `db:rollback` | Xem revision / lùi 1 bước |
| `npm run api` | API native `:8000` (`--reload`) |
| `npm run desktop` | Tauri + Vite |
| `npm run desktop:build` | Cài deps protocol/desktop + đóng gói MSI |
| `npm run extension:install` | Fallback cài IDE extension |
| `npm test` | Test protocol + desktop |

---

## 8. Tài liệu khác

- Production / CI: [`docs/DESKTOP_DEPLOYMENT_GUIDE.md`](docs/DESKTOP_DEPLOYMENT_GUIDE.md)
- Kiến trúc: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- API: [`api/README.md`](api/README.md)
- Desktop: [`desktop/README.md`](desktop/README.md)

## License

MIT
