# AITest Platform

Hệ thống Quản lý & Sinh mã Kiểm thử tự động (Unit Test & E2E Test Engine) cho QA & Developer.
- **Desktop App**: React 19 + Vite 6 + Tauri 1.6
- **Backend API**: Python 3.12 + FastAPI + SQLAlchemy 2 + Alembic
- **Database**: PostgreSQL 16 (Docker Container)
- **IDE Extension**: Cursor / VS Code Extension (`aitest-ide`) + Cursor Agent CLI (`agent`)

---

## 1. Yêu cầu công cụ & Thư viện (Prerequisites)

Để cài đặt và chạy toàn bộ hệ thống AITest trên máy phát triển, bạn cần chuẩn bị các công cụ sau:

### Công cụ chung (Mọi Hệ điều hành)
- **Node.js**: phiên bản LTS **20.x** trở lên (`node -v`)
- **Python**: phiên bản **3.12+** kèm `pip` và `venv` (`python --version`)
- **Docker & Docker Compose**: Docker Desktop (hoặc Docker Engine v2) để chạy PostgreSQL (`docker compose version`)
- **Rust Toolchain**: phiên bản Stable **1.70+** để biên dịch ứng dụng Tauri Desktop (`rustc --version`)
- **Cursor IDE** hoặc **VS Code**: để cài đặt IDE Extension
- **Cursor Agent CLI**: CLI sinh mã AI (`agent` hoặc `cursor-agent`), đã thực hiện đăng nhập tài khoản Cursor (`agent login`).

### Cấu hình phụ thuộc theo OS

#### 🪟 Windows:
1. **C++ Build Tools**: Cài đặt Visual Studio Build Tools 2022 (chọn gói **Desktop development with C++** và **Windows SDK**) — bắt buộc để biên dịch Rust/Tauri và `node-gyp`.
2. **Quyền chạy PowerShell Script**: Mở PowerShell với quyền Admin và chạy:
   ```powershell
   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```

#### 🐧 Linux (Ubuntu / Debian):
Cài đặt các gói thư viện hệ thống cho Tauri 1.6:
```bash
sudo apt update
sudo apt install -y build-essential libssl-dev libgtk-3-dev libwebkit2gtk-4.0-dev libayatana-appindicator3-dev librsvg2-dev curl wget file
```

#### 🍎 macOS:
Cài đặt Xcode Command Line Tools:
```bash
xcode-select --install
```

---

## 2. Chi tiết Thư viện Công nghệ (Tech Stack Dependencies)

| Component | Công nghệ chính | Các thư viện nổi bật |
| :--- | :--- | :--- |
| **Backend API** (`api/`) | Python 3.12 / FastAPI | `fastapi`, `uvicorn`, `sqlalchemy 2.0`, `psycopg 3`, `alembic`, `pydantic v2`, `python-jose`, `cryptography`, `pytest` |
| **Desktop App** (`desktop/`) | React 19 / Vite 6 / Tauri 1.6 | `@tauri-apps/api`, `antd` (Ant Design 6), `zustand`, `react-router-dom v7`, `@tanstack/react-query v5`, `mermaid` |
| **IDE Extension** (`ide-plugins/`) | TypeScript / VS Code Extension API | `@aitest/ide-protocol`, WebSocket server (`bridgeServer.ts`) |
| **Monorepo Core** (`packages/`) | TypeScript | `@aitest/ide-protocol` |

---

## 3. Cài đặt & Chạy dự án

Mọi lệnh `npm run ...` được thực thi từ **thư mục gốc của kho mã nguồn (Root Repo)**.

### 🚀 Cách 1: Tự động hóa 1-Click (Dành cho Windows)

```powershell
# 1. Clone repository
git clone <repo-url> AITest
cd AITest

# 2. Khởi tạo môi trường lần đầu (Tự động tạo Docker DB, Python venv, pip install, migrate schema & npm install)
npm run setup

# 3. Chạy toàn bộ hệ thống (Postgres Docker + API Server 5088 + Desktop App)
npm run up
```

---

### 🛠️ Cách 2: Chạy thủ công từng bước (Tất cả OS: Windows, Linux, macOS)

#### Bước 1: Khởi động CSDL PostgreSQL (Docker)
```bash
npm run db
```
*(Khởi chạy PostgreSQL container tại cổng host `:5433`)*

#### Bước 2: Cấu hình và chạy Backend API (Python FastAPI)
```bash
# Di chuyển vào thư mục api
cd api

# Tạo file .env từ file mẫu
cp .env.example .env

# Tạo và kích hoạt môi trường ảo Python
python3 -m venv .venv
source .venv/bin/activate       # Trên Windows: .\.venv\Scripts\Activate.ps1

# Cài đặt thư viện Python
pip install --upgrade pip
pip install -r requirements.txt

# Thực thi Alembic Database Migration
alembic upgrade head

# Chạy API Server (Native Port 5088)
uvicorn app.main:app --host 0.0.0.0 --port 5088
```

#### Bước 3: Cài đặt & Chạy Desktop App (Terminal mới)
```bash
# Từ thư mục gốc repo:
npm run protocol:install
npm run desktop:install
npm run desktop
```

#### Bước 4: Cài đặt IDE Extension (Cursor / VS Code)
```bash
npm run extension:install
```

---

## 4. Địa chỉ truy cập & Tài khoản thử nghiệm

Khi hệ thống đã khởi động thành công:

| Dịch vụ | URL / Thông tin |
| :--- | :--- |
| **Trang chủ API Healthcheck** | `http://localhost:5088/health` |
| **Swagger API Documentation** | `http://localhost:5088/docs` |
| **Tài khoản Admin mặc định** | **Email**: `admin@aitest.com` \| **Mật khẩu**: `Admin@123` |
| **Đăng ký tài khoản mới** | Truy cập màn hình Đăng ký trên Desktop App hoặc đường dẫn `/register` |

---

## 5. Đóng gói ứng dụng Desktop (Build Installer)

Để tạo bộ cài đặt Native (`.msi` trên Windows, `.deb`/`.AppImage` trên Linux, `.dmg` trên macOS):

```bash
# 1. Đặt biến môi trường Backend API endpoint
export VITE_API_URL="http://<IP_SERVER_BE>:5000/api"    # Windows PowerShell: $env:VITE_API_URL="http://..."

# 2. Thực thi lệnh đóng gói
npm run desktop:build
```
- **File đầu ra**: nằm tại `desktop/src-tauri/target/release/bundle/msi/` (hoặc `deb`/`dmg`).

---

## 6. Danh sách lệnh NPM Scripts (Root Repo)

| Lệnh `npm run` | Mô tả chức năng |
| :--- | :--- |
| `npm run setup` | Khởi tạo lần đầu: Docker Postgres ➔ Python venv ➔ Alembic Migration ➔ npm install |
| `npm run up` / `dev` | Chạy toàn bộ stack (Postgres + DB Migration + API + Desktop) |
| `npm run db` | Bật Container Postgres |
| `npm run db:down` | Dừng Container Postgres |
| `npm run db:up` | Áp dụng Database Migration mới nhất (`alembic upgrade head`) |
| `npm run db:migrate` | Tạo file SQL migration mới dựa trên Model thay đổi (`alembic revision --autogenerate`) |
| `npm run api` | Khởi chạy Backend API Native tại cổng `:5088` |
| `npm run desktop` | Khởi chạy Desktop App (Tauri + Vite UI) |
| `npm run desktop:build` | Đóng gói bộ cài ứng dụng Desktop (.msi / .deb / .dmg) |
| `npm run extension:install` | Build và cài đặt IDE Extension vào Cursor / VS Code |
| `npm test` | Thực thi toàn bộ Unit Tests trong monorepo |

---

## 7. Tài liệu chi tiết khác

- 📘 **Hướng dẫn Triển khai Production & CI/CD**: [`docs/DESKTOP_DEPLOYMENT_GUIDE.md`](docs/DESKTOP_DEPLOYMENT_GUIDE.md)
- 📐 **Kiến trúc Hệ thống**: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- 🔌 **Cấu hình Backend API**: [`api/README.md`](api/README.md)
- 💻 **Cấu hình Desktop App**: [`desktop/README.md`](desktop/README.md)

---

## License

MIT License
