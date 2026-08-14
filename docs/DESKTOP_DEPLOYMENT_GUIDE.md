# Hướng dẫn đóng gói & triển khai AITest

| | |
|--|--|
| **Đối tượng** | DevOps, System Admin, QA Lead |
| **Phạm vi** | Backend (FastAPI + PostgreSQL) và phát hành AITest Desktop (Windows, Linux, macOS) |
| **Phiên bản** | 2.5.0 · 14/08/2026 |
| **Source** | `docker-compose.production.yml`, `deploy.sh`, `.env.production.example`, `desktop/src-tauri/tauri.conf.json`, `desktop/package.json`, `desktop/src-tauri/Cargo.toml`, `.github/workflows/ci.yml` |

Bí mật (mật khẩu DB, JWT, encryption, chứng chỉ signing) chỉ nằm trong file env trên máy chủ hoặc CI secrets — không commit vào git, không dán vào tài liệu này.

**Trạng thái (đối chiếu source, không phải changelog tài liệu):**

```text
Current / As-built
  Backend:  deploy.sh + docker-compose.production.yml  (hoặc native api/.env)
  Desktop:  Windows MSI  —  tauri.conf.json bundle.targets = ["msi"]
  CI:       .github/workflows/ci.yml  (Go + frontend/; không đóng gói Desktop)
  Không có: release.sh, .gitlab-ci.yml, workflow build MSI/DEB/DMG

Target
  Desktop:  Windows .msi + Linux .deb/.AppImage + macOS .dmg
  Release:  một git tag → CI/CD 3 runner → GitHub Release
```

---

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Kiến trúc triển khai](#2-kiến-trúc-triển-khai)
3. [Triển khai Backend](#3-triển-khai-backend)
4. [Phát hành Desktop](#4-phát-hành-desktop)
5. [Môi trường build & CI/CD đa nền tảng](#5-môi-trường-build--cicd-đa-nền-tảng)
6. [Đóng gói Desktop](#6-đóng-gói-desktop)
7. [CI/CD — vai trò, pipeline, phân phối](#7-cicd--vai-trò-pipeline-phân-phối)
8. [Code signing](#8-code-signing)
9. [Checklist phát hành](#9-checklist-phát-hành)

---

## 1. Tổng quan

AITest gồm hai lớp độc lập. Không gộp Backend deploy và Desktop release.

| Lớp | Chạy ở đâu | Vai trò |
|-----|------------|---------|
| **Backend** | Máy chủ (hoặc máy local) | PostgreSQL + FastAPI: user, dự án, requirement, test case, jobs |
| **Desktop + IDE Extension + Agent CLI** | Máy QA / Dev | Đọc/ghi repo SUT trên đĩa local. Không upload toàn bộ source lên Backend |

```text
Backend (một lần trên server)
  Production Server → Docker Compose (hoặc native) → FastAPI + PostgreSQL

Desktop (mỗi máy người dùng, đúng OS)
  Cài artifact native → HTTP/JWT (VITE_API_URL) → Backend
  As-built: MSI. Target: thêm DEB / AppImage / DMG do CI runner từng OS tạo.
```

`./deploy.sh` chỉ triển khai Backend. Không đóng gói Desktop.

Desktop kết nối Backend qua `VITE_API_URL` (cấu hình lúc **build**). Gen Unit / E2E chạy trên máy QA (extension `aitest-ide` + Cursor Agent CLI).

CI/CD **không** chạy AITest Desktop cho QA. CI/CD chỉ build, test, ký và phát hành bộ cài. Sau khi cài, app chạy trên máy QA/Dev.

Không có một file build trên Windows chạy được trên Linux hay macOS. Mỗi OS một artifact native, build trên runner cùng OS.

---

## 2. Kiến trúc triển khai

### 2.1 Runtime (luôn đúng — Backend + máy QA)

```text
Máy chủ
  Docker Compose (hoặc Python native)
    FastAPI  +  PostgreSQL 16

Máy QA / Dev
  AITest Desktop          ── HTTP/JWT (VITE_API_URL) ──►  FastAPI
  Cursor / VS Code + aitest-ide
  Cursor Agent CLI (cwd = thư mục SUT)
  Đĩa local: AItest/ · .ai-test/
```

Cổng API mặc định trong repo (phải khớp `VITE_API_URL` lúc build Desktop):

| Ngữ cảnh | Cổng API trên host | Postgres trên host |
|----------|--------------------|--------------------|
| Native — `api/.env.example` | **5088** | `localhost:5433` |
| `docker-compose.yml` (dev) | **5100** → container 8080 | **5433** → 5432 |
| `docker-compose.production.yml` | **`${API_PORT:-5000}`** → 8080 | **`${POSTGRES_PORT:-5433}`** → 5432 |

Health check API: `GET /health` (không prefix `/api`). Desktop dùng base `http://<host>:<port>/api`.

Ba bản Desktop production trỏ **cùng một** Backend. Không tạo 3 Backend vì có 3 OS.

### 2.2 Phát hành Desktop — kiến trúc Target (CI/CD)

Developer làm việc trên một máy (thường Windows), **một lần** push tag. CI/CD build trên từng runner. Developer **không** cần Linux/macOS tại chỗ, **không** build Linux/macOS trên máy Windows.

```text
Developer (Windows hoặc máy bất kỳ)
   │
   │ Git Push / Release Tag
   ▼
CI/CD Pipeline          ← không phải runtime của Desktop
   │
   ├── Windows Runner
   │      ↓  Tauri Build
   │      .msi
   │
   ├── Linux Runner
   │      ↓  Tauri Build
   │      .deb / .AppImage
   │
   └── macOS Runner
          ↓  Tauri Build
          .dmg
```

| Artifact | Build trên |
|----------|------------|
| `.msi` | Windows runner |
| `.deb` / `.AppImage` | Linux runner |
| `.dmg` | macOS runner |

**As-built:** chỉ `.msi` khi `tauri build` trên Windows (`bundle.targets = ["msi"]`). Linux/macOS **chưa** bật trong config; pipeline 3 runner **chưa** có trong repo.

---

## 3. Triển khai Backend

Hai phương án cùng một API + Postgres. Khác cách cài. Desktop / CLI / SUT luôn ở máy người dùng.

| | **A · Docker Compose** | **B · Native (Python + Postgres)** |
|--|------------------------|-------------------------------------|
| File | `docker-compose.production.yml` + `.env.production` + `./deploy.sh` | `api/.env` (từ `api/.env.example`) + venv + uvicorn |
| Postgres | Container `postgres:16-alpine`, volume `postgres_prod_data` | Dịch vụ OS hoặc instance có sẵn |
| API | Container từ `api/Dockerfile`, listen 8080 trong container | `uvicorn` trên host |
| Migration | `deploy.sh` → `alembic upgrade head` trong container | Tự chạy `alembic` trong venv |
| Khi nào dùng | Có Docker; muốn staging/prod giống nhau | Không Docker; Postgres do DBA quản lý |

---

### Phương án A — Docker Compose

Tách biệt `docker-compose.yml` (dev: API host **5100**, mật khẩu mẫu `postgres`). File production **bắt buộc** `POSTGRES_PASSWORD`, `JWT_KEY`, `ENCRYPTION_KEY` — thiếu thì Compose dừng.

#### A.1 Thành phần & mạng

Ba file ở **thư mục gốc repo**:

| File | Vai trò |
|------|---------|
| `docker-compose.production.yml` | Service `postgres`, `api` và volume DB |
| `.env.production.example` | Mẫu biến — copy thành `.env.production` rồi điền secret |
| `deploy.sh` | Kiểm tra Docker → `up --build` → Alembic → in URL |

```text
Host
  ${API_PORT:-5000} ──────► api:8080
  ${POSTGRES_PORT:-5433} ─► postgres:5432
Mạng Compose:
  hostname `postgres` port 5432  ← API dùng cổng này, không dùng 5433
Volume:
  postgres_prod_data  — xóa volume = mất dữ liệu
```

#### A.2 Chuẩn bị máy chủ

1. Docker Engine + Compose v2 (`docker compose version`).
2. Có `api/` (`Dockerfile`, `requirements.txt`, `app/`), `docker-compose.production.yml`, `deploy.sh`, `.env.production.example`.
3. `cp .env.production.example .env.production` — thay mọi `<SET_ME…>`.
4. Firewall: mở cổng API. Không public cổng Postgres trừ khi cần.

#### A.3 `.env.production`

Mẫu (`.env.production.example`). Tự sinh mật khẩu và khóa (≥ 32 ký tự cho JWT / encryption).

```env
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<SET_ME>
POSTGRES_DB=AITestDb
POSTGRES_PORT=5433

API_PORT=5000
JWT_KEY=<SET_ME_MIN_32_CHARS>
ENCRYPTION_KEY=<SET_ME_MIN_32_CHARS>
JWT_ISSUER=AITest.API
JWT_AUDIENCE=AITest.Client
JWT_ACCESS_HOURS=24
CORS_ORIGINS=http://localhost:5173,tauri://localhost,http://tauri.localhost

AITEST_RULE_RETRIEVE_MODE=selective
AITEST_RULE_RETRIEVE_E2E=1
AITEST_RULE_RETRIEVE_ANALYSIS=1
AITEST_RULE_RETRIEVE_TCGEN=1
```

| Biến | Bắt buộc | Mặc định Compose | Ý nghĩa |
|------|----------|------------------|---------|
| `POSTGRES_USER` | Không | `postgres` | User trong container Postgres |
| `POSTGRES_PASSWORD` | Có | Fail (`:?`) | Mật khẩu DB |
| `POSTGRES_DB` | Không | `AITestDb` | Tên database |
| `POSTGRES_PORT` | Không | `5433` | Cổng Postgres trên **host** (trong container: 5432) |
| `API_PORT` | Không | `5000` | Cổng API trên **host** (trong container: 8080) |
| `DATABASE_URL` | Không | `postgresql://USER:PASS@postgres:5432/DB` | Chỉ set khi Postgres nằm ngoài stack |
| `JWT_KEY` | Có | Fail | Ký JWT |
| `ENCRYPTION_KEY` | Có | Fail | Mã hóa secret connection trong DB |
| `JWT_ISSUER` / `JWT_AUDIENCE` | Không | `AITest.API` / `AITest.Client` | Claim JWT; Desktop cùng audience |
| `JWT_ACCESS_HOURS` | Không | `24` | TTL access token |
| `CORS_ORIGINS` | Không | `*` nếu biến trống | Origin Desktop/Vite. Production nên liệt kê cụ thể |
| `AITEST_RULE_RETRIEVE_*` | Không | `selective` / `1` | Cách API lấy rule fragment khi gen |

`deploy.sh` từ chối chạy nếu `.env.production` còn `<SET_ME`.

#### A.4 `docker-compose.production.yml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Error: POSTGRES_PASSWORD is required in .env.production}
      POSTGRES_DB: ${POSTGRES_DB:-AITestDb}
    ports:
      - "${POSTGRES_PORT:-5433}:5432"
    volumes:
      - postgres_prod_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-AITestDb}"]
      interval: 5s
      timeout: 5s
      retries: 10

  api:
    build:
      context: ./api
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      PORT: "8080"
      DATABASE_URL: ${DATABASE_URL:-postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-AITestDb}}
      JWT_KEY: ${JWT_KEY:?Error: JWT_KEY is required in .env.production}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?Error: ENCRYPTION_KEY is required in .env.production}
      JWT_ISSUER: ${JWT_ISSUER:-AITest.API}
      JWT_AUDIENCE: ${JWT_AUDIENCE:-AITest.Client}
      JWT_ACCESS_HOURS: ${JWT_ACCESS_HOURS:-24}
      CORS_ORIGINS: ${CORS_ORIGINS:-*}
      AITEST_RULE_RETRIEVE_MODE: ${AITEST_RULE_RETRIEVE_MODE:-selective}
      AITEST_RULE_RETRIEVE_E2E: ${AITEST_RULE_RETRIEVE_E2E:-1}
      AITEST_RULE_RETRIEVE_ANALYSIS: ${AITEST_RULE_RETRIEVE_ANALYSIS:-1}
      AITEST_RULE_RETRIEVE_TCGEN: ${AITEST_RULE_RETRIEVE_TCGEN:-1}
    ports:
      - "${API_PORT:-5000}:8080"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres_prod_data:
```

**postgres**

| Khóa | Việc làm |
|------|----------|
| `image: postgres:16-alpine` | PostgreSQL 16 |
| `restart: unless-stopped` | Tự lên khi Docker restart; không lên nếu `stop` tay |
| `POSTGRES_*` | Init user/db **lần đầu** tạo volume. Đổi password trong env sau đó không đổi user đã init — dùng `ALTER USER` hoặc volume mới |
| `ports` | Tool trên host: `localhost:5433`. API trong Compose **không** dùng cổng này |
| `postgres_prod_data` | Giữ data khi `compose down` (không `-v`) |
| `healthcheck` | `api` chờ `pg_isready` trước khi start |

**api**

| Khóa | Việc làm |
|------|----------|
| `build.context: ./api` | Image từ `api/Dockerfile` |
| `PORT: "8080"` | Cổng trong container; không lấy từ `API_PORT` |
| `DATABASE_URL` | Host `postgres`, port **5432**. Sai nếu ghi `localhost:5433` trong container |
| `JWT_KEY` / `ENCRYPTION_KEY` | Thiếu biến → `docker compose` dừng |
| `ports: API_PORT:8080` | Máy QA gọi `http://<host>:<API_PORT>/...` |
| `depends_on` + `service_healthy` | Không start API khi Postgres chưa sẵn |

`api/Dockerfile`: `python:3.12-slim`, cài `requirements.txt`, copy `app/`, `uvicorn app.main:app --host 0.0.0.0 --port 8080`. Secret inject lúc runtime từ `.env.production`, không copy `.env` vào image.

#### A.5 `deploy.sh`

Chạy từ thư mục gốc repo. Linux / macOS / Git Bash / WSL: `chmod +x deploy.sh && ./deploy.sh`. PowerShell thuần: dùng các lệnh `docker compose` tương đương.

| Bước | Việc |
|------|------|
| `set -e` | Lệnh fail thì thoát |
| Kiểm tra `docker` và `docker compose version` | Thiếu thì dừng |
| Không có `.env.production` | Copy từ example rồi **thoát** — bắt điền secret |
| Còn `<SET_ME` | Dừng |
| Đọc `API_PORT` | In URL cuối; mặc định `5000` |
| `up -d --build` | Build image API, start 2 container |
| `exec -T api alembic upgrade head` | Migration (`-T` = không TTY) |
| `ps` | Trạng thái container |
| In `http://localhost:${API_PORT}/api` | Base URL cho Desktop (`VITE_API_URL`) |

Mọi lệnh Compose kèm `--env-file .env.production`.

#### A.6 Chạy và kiểm tra

```bash
cp .env.production.example .env.production
# Điền secret, không để <SET_ME>

chmod +x deploy.sh
./deploy.sh
```

Tương đương tay:

```bash
docker compose -f docker-compose.production.yml --env-file .env.production up -d --build
docker compose -f docker-compose.production.yml --env-file .env.production exec -T api alembic upgrade head
docker compose -f docker-compose.production.yml --env-file .env.production ps
```

```bash
curl -sS "http://127.0.0.1:${API_PORT:-5000}/health"
```

`GET /health` trả `status: ok`. Desktop: `VITE_API_URL=http://<host-api>:<API_PORT>/api`.

Lần chạy đầu (DB trống): `api/app/seed.py` tạo `admin@aitest.com` / `Admin@123`. Đổi mật khẩu ngay trên môi trường thật.

#### A.7 Vận hành

```bash
docker compose -f docker-compose.production.yml --env-file .env.production logs -f api
docker compose -f docker-compose.production.yml --env-file .env.production logs -f postgres
docker compose -f docker-compose.production.yml --env-file .env.production down      # giữ volume
docker compose -f docker-compose.production.yml --env-file .env.production down -v   # xóa data Postgres
```

| Việc | Cách |
|------|------|
| Đổi JWT / CORS / rule flags | Sửa `.env.production` → `up -d` |
| Đổi `POSTGRES_PASSWORD` khi volume đã init | `ALTER USER` trong DB, hoặc `down -v` rồi `up` |
| Rebuild API sau pull code | `./deploy.sh` hoặc `up -d --build` rồi Alembic |

---

### Phương án B — Native: PostgreSQL + Python 3.12

API chạy uvicorn trên OS. Postgres là service máy hoặc instance có sẵn.

```text
Host
  PostgreSQL 16     ${PGPORT:-5433}
  uvicorn           ${PORT:-5088}     ← api/.env.example
Máy QA
  VITE_API_URL = http://<host>:${PORT}/api
```

1. Tạo database (mặc định repo: `AITestDb`), user và mật khẩu.
2. Python 3.12, pip.
3. `api/.env.example` → `api/.env`. Sửa `DATABASE_URL`, `JWT_KEY`, `ENCRYPTION_KEY`, `PORT`, `CORS_ORIGINS`.
4. `DATABASE_URL` dạng libpq (như example) hoặc `postgresql://user:pass@host:port/db`. Không commit `api/.env`.

**Linux / macOS**

```bash
cd api
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
set -a && source .env && set +a
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-5088}"
```

Production: `--workers` theo CPU, hoặc systemd với `EnvironmentFile=` trỏ `api/.env`.

**Windows**

```powershell
cd api
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port 5088
```

Cổng lấy từ `PORT` trong `.env`. Có thể đăng ký Windows Service (NSSM) với cùng env.

```bash
curl -sS "http://127.0.0.1:${PORT:-5088}/health"
```

---

## 4. Phát hành Desktop

Stack: Tauri **1.6** (`@tauri-apps/cli` ^1.6.2), React 19, Vite 6, Rust edition 2021 (`rust-version = "1.70"` trong `Cargo.toml`). Node.js LTS 20+. `productName`: **AITest Desktop**. Version hiện tại: **0.1.0** (`tauri.conf.json`, `desktop/package.json`, `Cargo.toml`). Rust `commands.rs` đã có nhánh Windows (`cmd`) / Unix (`sh`) / `open` / `xdg-open`.

Trên máy QA sau khi cài: Cursor + `aitest-ide`, Agent CLI trên PATH, gắn thư mục SUT, Connect IDE. SUT và CLI **không** chạy trong CI.

### 4.1 As-built

```text
Windows → MSI     (tauri build trên Windows; targets = ["msi"])
Linux   → chưa bật
macOS   → chưa bật
```

Lệnh local (Windows): `npm run desktop:install` rồi `npm run desktop:build` (`tauri build` trong `desktop/`).

### 4.2 Target

```text
Windows → .msi
Linux   → .deb và .AppImage
macOS   → .dmg
```

Một lần trigger — Developer **không** chạy 3 lệnh build trên 3 máy:

```text
Developer
    ↓
git tag + git push
    ↓
CI/CD
    ↓
Build Windows  |  Build Linux  |  Build macOS     (song song, mỗi job một OS)
    ↓
Collect artifacts
    ↓
Publish Release
```

Ví dụ (repo **không** có `release.sh`):

```text
git tag v0.1.0
git push origin v0.1.0
```

Đây là **release architecture mục tiêu**. Workflow 3 runner **chưa** có trong source.

---

## 5. Môi trường build & CI/CD đa nền tảng

CI/CD cung cấp runner. Developer Windows không tự cài Linux/macOS để ra DEB/DMG. Máy QA không cần Rust — chỉ cài artifact.

### Windows Runner

- Windows 10/11 64-bit hoặc `windows-latest`
- Node.js LTS 20+
- Rust stable, target `x86_64-pc-windows-msvc`
- Visual Studio Build Tools 2022: Desktop C++ + Windows SDK
- WiX v3 (Tauri 1 có thể tự tải khi `tauri build`)
- Artifact **as-built và target:** `.msi`

### Linux Runner

- Ubuntu 22.04/24.04 hoặc `ubuntu-latest`
- Node.js LTS 20+
- Rust stable, điển hình `x86_64-unknown-linux-gnu`
- Tauri 1: `libwebkit2gtk-4.0-dev` (không dùng 4.1 của Tauri 2), `libgtk-3-dev`, `libssl-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `build-essential`
- Artifact **target** (chưa có trong `bundle.targets`): `.deb`, `.AppImage`

### macOS Runner

- macOS 13+ hoặc `macos-latest`
- Node.js LTS 20+
- Rust stable
- Xcode Command Line Tools
- Artifact **target** (chưa có trong `bundle.targets`): `.dmg`

| Target Rust | Máy |
|-------------|-----|
| `aarch64-apple-darwin` | Apple Silicon (`macos-latest` hiện nay) |
| `x86_64-apple-darwin` | Intel — job / `--target` riêng |

Không cấu hình Universal Binary trong repo. Mỗi arch một DMG trừ khi sau này thêm.

Cursor / Agent CLI trên máy QA đã login; không nhúng API key vendor vào Desktop.

---

## 6. Đóng gói Desktop

### 6.1 Cấu hình Tauri

`desktop/src-tauri/tauri.conf.json` — `identifier`: `com.aitest.desktop`.

**As-built**

```json
"bundle": {
  "active": true,
  "targets": ["msi"],
  "identifier": "com.aitest.desktop",
  "icon": ["icons/icon.ico"]
}
```

**Target** — đổi `targets` (Tauri 1.6 hỗ trợ các giá trị này):

```json
"targets": ["msi", "dmg", "deb", "appimage"]
```

| OS | Target | File | Trạng thái |
|----|--------|------|------------|
| Windows | `msi` | `.msi` | As-built |
| Linux | `deb`, `appimage` | `.deb`, `.AppImage` | Target — chưa bật |
| macOS | `dmg` | `.dmg` | Target — chưa bật |

Icon Target: `32x32.png`, `128x128.png`, `icon.icns`, `icon.ico` (`npx tauri icon <png>`). Config hiện chỉ `icons/icon.ico`.

Không bật `updater`. Cập nhật = cài bản mới. Khi bật: `endpoints` + `pubkey` thật.

`tauri build` trên Windows **không** tạo `.dmg` / `.deb`. Mỗi artifact chỉ ra trên runner cùng OS.

### 6.2 `VITE_API_URL` (build-time)

`desktop/src/api/client.ts`: `import.meta.env.VITE_API_URL`, fallback `http://127.0.0.1:5088/api`. Vite `envPrefix`: `VITE_`, `TAURI_`. Nhúng lúc `vite build` (`beforeBuildCommand`). Không đổi sau khi đã cài.

Một Backend production → cùng URL trên cả ba job:

```text
https://api.example.com/api
          │
          ├── Windows build → MSI
          ├── Linux build   → DEB / AppImage
          └── macOS build   → DMG
```

CORS: `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost` (đã có trong `api/.env.example`).

### 6.3 Lệnh build local (đúng OS)

```bash
npm run desktop:install
export VITE_API_URL="https://<host-api>/api"   # PowerShell: $env:VITE_API_URL=...
npm run desktop:build
```

Đường dẫn as-built (Windows):

`desktop/src-tauri/target/release/bundle/msi/AITest Desktop_{version}_x64_en-US.msi`

Tên `.dmg` / `.deb` / `.AppImage` do Tauri 1 đặt khi build trên runner đó — lấy từ `bundle/`, không đặt tên sẵn trong tài liệu.

---

## 7. CI/CD — vai trò, pipeline, phân phối

### 7.1 CI/CD có vai trò gì?

CI/CD tự động hóa:

```text
Source Code → Checkout → Install dependencies → Build → Test
    → Package → Sign → Publish Artifact → Release
```

Với AITest Desktop (Target):

```text
                    CI/CD
                      │
          ┌───────────┼───────────┐
          ↓           ↓           ↓
      Windows       Linux       macOS
       Runner       Runner       Runner
          ↓           ↓           ↓
        MSI       DEB/AppImage    DMG
```

CI/CD **không** chạy AITest Desktop cho QA. CI/CD chỉ build và phát hành. Desktop sau khi cài chạy trên máy QA/Dev và gọi Backend qua HTTP/JWT.

### 7.2 As-built CI

`.github/workflows/ci.yml` (push `main`/`develop`, PR `main`):

- `api`: Go `api/cmd/server` — không khớp FastAPI hiện tại
- `frontend/`: không phải `desktop/` Tauri
- `docker`: `docker compose build` trên `main`

Không build Desktop, không upload MSI/DMG/DEB, không GitHub Release Desktop. Không có `.gitlab-ci.yml`. Không có `release.sh`. `deploy.sh` chỉ Backend.

### 7.3 Pipeline Target (Recommended Architecture)

Thêm workflow GitHub Actions (tag, ví dụ `v*`). `deploy.sh` không dùng cho bước này.

Mỗi job: checkout → Node 20+ → Rust stable → deps native OS → `VITE_API_URL` chung → `npm ci` trong `desktop/` (+ `packages/ide-protocol` nếu cần) → `tauri build` (có thể `tauri-apps/tauri-action`, Tauri 1).

Ba job song song. Collect rồi publish. Chỉ upload file job đã tạo thành công.

**As-built (Tauri trên Windows):** `AITest Desktop_0.1.0_x64_en-US.msi`

**Target — nhóm artifact trên Release** (tên file Linux/macOS xác nhận sau lần build đầu trên runner):

```text
Release 0.1.0
│
├── Windows
│     AITest Desktop_0.1.0_x64_en-US.msi
├── Linux
│     *.deb
│     *.AppImage
└── macOS
      *.dmg
```

---

## 8. Code signing

Không commit certificate / private key. Dùng CI secrets. As-built: **chưa** có bước signing trong repo.

### Windows

Chứng chỉ Authenticode. Sign MSI trên Windows runner nếu production yêu cầu (secret PFX + mật khẩu).

### macOS

Apple Developer ID, codesign, notarization nếu phát hành public (Gatekeeper). Secret: cert + Apple ID / API key. Chưa cấu hình.

### Linux

Có thể phân phối `.deb` / `.AppImage` chưa ký. GPG / AppImage signing khi policy yêu cầu — chưa có trong project.

---

## 9. Checklist phát hành

Đánh dấu khi đã chạy trên môi trường đích. Hạng mục Linux/macOS / 3-runner chỉ khi đã làm xong Target (§6.1, §7.3).

### Backend

- [ ] `.env.production` hoặc `api/.env` đã điền secret; không commit file env
- [ ] `GET /health` → `status: ok`
- [ ] `alembic upgrade head` xong
- [ ] CORS cho phép origin Tauri / Desktop

### Build

- [ ] Windows runner build PASS
- [ ] Windows MSI tạo thành công
- [ ] Linux runner build PASS
- [ ] Linux DEB/AppImage tạo thành công
- [ ] macOS runner build PASS
- [ ] macOS DMG tạo thành công
- [ ] `bundle.targets` gồm `msi`, `dmg`, `deb`, `appimage`
- [ ] Icon png + icns + ico
- [ ] Version trùng `package.json` / `Cargo.toml` / `tauri.conf.json`

### Install

- [ ] Windows install/uninstall PASS
- [ ] Linux install/open PASS
- [ ] macOS install/open PASS

### Application (mỗi OS đã cài)

- [ ] Login PASS
- [ ] Backend connection PASS (`VITE_API_URL`)
- [ ] Connect IDE PASS
- [ ] Agent CLI READY
- [ ] Generate Unit Test Case PASS
- [ ] Generate E2E PASS
- [ ] Run test PASS
- [ ] Artifact/report trên đĩa SUT (`AItest/`) PASS

### Release

- [ ] Version đồng nhất ba OS
- [ ] `VITE_API_URL` đúng (cùng Backend production)
- [ ] Windows signing PASS nếu áp dụng
- [ ] macOS signing PASS nếu áp dụng
- [ ] macOS notarization PASS nếu áp dụng
- [ ] Tất cả artifact được upload
- [ ] Download/install test trên cả 3 OS
