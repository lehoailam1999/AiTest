# AITest

Desktop QA: sinh TC → Approve → sinh Unit/E2E → Verify.  
**Desktop** (React + Tauri) · **API** (FastAPI + Postgres) · **IDE Extension** + AI CLI trên máy user.

| Docs | |
|------|--|
| API | [`api/README.md`](api/README.md) |
| Deploy | [`docs/DESKTOP_DEPLOYMENT_GUIDE.md`](docs/DESKTOP_DEPLOYMENT_GUIDE.md) |
| Kiến trúc | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |

## Clone → chạy (Windows)

**Cần:** Docker Desktop, Python 3.12+, Node 20+, Rust (cho Tauri).

```powershell
git clone <repo-url> AITest
cd AITest

npm run setup    # Postgres + api/.venv + migrate + protocol + desktop (+ extension)
npm run up       # Postgres → migrate → API + Desktop (2 cửa sổ mới)
```

| | |
|--|--|
| Health | http://localhost:5088/health |
| Swagger | http://localhost:5088/docs |
| Login | `admin@aitest.com` / `Admin@123` |
| Desktop → API | `http://127.0.0.1:5088/api` (mặc định trong code) |

`npm run setup:no-ext` — bỏ bước cài IDE extension.

### Mỗi ngày (đã setup)

```powershell
npm run up
# hoặc: npm run db && npm run db:up && npm run api   (+ terminal khác: npm run desktop)
```

### IDE (Unit / E2E Gen)

```powershell
npm run extension:install
# Reload Window trong Cursor/VS Code → status bar AITest :port
```

## Script npm

| Lệnh | Việc |
|------|------|
| `npm run setup` | Setup lần đầu sau clone |
| `npm run up` / `dev` | Chạy stack local (app) |
| `npm run db` | Bật Postgres |
| `npm run db:migrate` | Sync schema rồi gen SQL diff vào `alembic/versions/` |
| `npm run db:up` | Chạy các file trong `versions/` lên DB |
| `npm run db:stamp` | Đánh dấu DB = head (schema đã đủ, không chạy SQL) |
| `npm run db:status` | Xem Alembic revision hiện tại |
| `npm run api` | API native (port **5088**) |
| `npm run desktop` / `desktop:ui` | Tauri / chỉ Vite |
| `npm run extension:install` | Cài extension |
| `npm test` | protocol + desktop tests |

Chi tiết migrate: [`api/README.md`](api/README.md).

## Cấu trúc

```
api/  desktop/  ide-plugins/  packages/ide-protocol/  docs/
scripts/             # chỉ setup / up / extension:install (phức tạp)
docker-compose.yml
deploy.sh
```

Lệnh thường ngày nằm trong `package.json` (`npm run db`, `api`, `desktop`…) — không cần file script riêng.
## Docker full API (tuỳ chọn)

```powershell
docker compose up -d
# API http://localhost:5100 — Desktop mặc định vẫn 5088; đổi VITE_API_URL nếu dùng path này
```

Dev thường ngày: **Postgres Docker + `npm run api` (5088)**.

## License

MIT
