# AITest API — Python

FastAPI + SQLAlchemy + PostgreSQL. Client: Desktop (Tauri).

Lần đầu sau clone (venv + npm + extension): [`../README.md`](../README.md) → `npm run setup` rồi `npm run up`.

## Chạy backend

Mọi thứ bắt đầu từ **Docker ở root repo** (`D:\Xlab\AITest`, nơi có `docker-compose.yml`). Không có Postgres thì `db:up` / API không connect được.

### Bước 1 — Bật Docker (trước hết)

Từ root:

```powershell
cd D:\Xlab\AITest

# Chỉ Postgres (đủ cho Dev + migrate) — giống npm run setup / npm run up
npm run db
# = docker compose up -d postgres  → host :5433

# Hoặc full stack (Postgres + API container)
docker compose up -d --build
# Postgres :5433 · API http://localhost:8000
```

Hai lệnh trên đều bật Postgres trước. `docker compose up -d --build` thêm container API nhờ `depends_on` + healthcheck.

### Bước 2 — Schema (trên máy host)

```powershell
npm run db:up       # DB trống → create_all + stamp head; đã có → áp versions/ còn thiếu
```

Cần `api/.venv` + `api/.env` (có sau `npm run setup`).

### Bước 3 — Chạy API

| Cách | Lệnh | Port | Khi nào |
|------|------|------|---------|
| **Dev (path chính)** | `npm run api` | **8000** | Sửa code, `--reload` — trùng `npm run up` |
| **Full Docker** | (đã lên ở bước 1 nếu dùng `compose … --build`) | **8000** | Không cần venv |

Dev:

```powershell
npm run api         # uvicorn --reload :8000
```

`api/.env`: `DATABASE_URL` … `port=5433`. Desktop: `http://127.0.0.1:8000/api`.

Full Docker: image chỉ `uvicorn`, **không** chạy Alembic — nên vẫn làm bước 2 trên host (hoặc DB trống thì startup tự `create_all` nếu chưa có `alembic_version`). Desktop trỏ container: `VITE_API_URL=http://127.0.0.1:8000/api`.

Dừng Postgres: `npm run db:down`.

## Database migrate

Postgres Docker phải đang chạy (bước 1):

```powershell
npm run db

# Sửa model — api/app/models/domain.py
npm run db:migrate   # upgrade head + gen file versions/0015_migration.py, …
# Mở file vừa tạo, kiểm tra SQL
npm run db:up
npm run db:status
```

| Lệnh | Việc |
|------|------|
| `npm run db` | Bật Postgres Docker (root repo) |
| `npm run db:down` | Stop Postgres |
| `npm run db:migrate` | `upgrade head` rồi autogen file mới |
| `npm run db:up` | Áp revision chưa chạy; DB trống → bootstrap + stamp head |
| `npm run db:status` | Revision hiện tại |
| `npm run db:rollback` | Downgrade 1 bước |
| `npm run db:stamp` | Đánh dấu = head (không chạy SQL) |

- Thêm / xóa model hoặc cột → ra file; `db:up` mới đổi DB.
- Tên file tự tăng `0013_…`, `0014_…`. Đừng xóa file đã áp — dùng `db:rollback` rồi mới xóa.
- Clone DB trống: `db:up` tạo schema từ model rồi stamp head (`0001_baseline` chỉ là marker).

## Endpoints & seed

| | Dev native | Full Docker |
|--|------------|-------------|
| Health | http://localhost:8000/health | http://localhost:8000/health |
| Swagger | http://localhost:8000/docs | http://localhost:8000/docs |
| Seed | `admin@aitest.com` / `Admin@123` | cùng |

## Env

`api/.env` ← copy `.env.example` (không commit).

| Biến | Dev native | API trong compose |
|------|------------|-------------------|
| `DATABASE_URL` | `host=localhost` … `port=5433` | `host=postgres` … `port=5432` |
| `PORT` | `8000` | `8080` (map host **8000**) |
