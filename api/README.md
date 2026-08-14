# AITest API — Python

FastAPI + SQLAlchemy + PostgreSQL. Client: Desktop (Tauri).

Người mới: [`../README.md`](../README.md) → `npm run setup` rồi `npm run up`.

## Database migrate

```powershell
# 1) Sửa entity/model (thêm/xóa/sửa field hoặc bảng)
# 2) Sync schema + gen SQL diff → api/alembic/versions/
npm run db:migrate

# 3) Áp file trong versions/ vào Postgres
npm run db:up

# Clone (đã có versions/ trong repo):
npm run db && npm run db:up
npm run db:status
```

`db:migrate` chạy `create_all` trước rồi mới autogen — để so đúng với DB đầy đủ (tránh gen lại cả schema vì API/`create_all` tạo bảng core ngoài Alembic). Vẫn mở file gen ra trước khi `db:up`.

Nếu DB đã đủ schema nhưng Alembic lệch version: `npm run db:stamp`.

## Chạy API

```powershell
npm run api
```

| | |
|--|--|
| Health | http://localhost:5088/health |
| Swagger | http://localhost:5088/docs |
| Seed | `admin@aitest.com` / `Admin@123` |

## Env

`api/.env` ← `.env.example` (không commit). Port mặc định **5088**.

API routes: Swagger `/docs`.
