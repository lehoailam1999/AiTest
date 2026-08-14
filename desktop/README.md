# AITest Desktop (React + Tauri)

UI + Tauri bridge; gọi Python API tại **`http://127.0.0.1:8000/api`** (mặc định trong code).

Người mới: từ gốc repo `npm run setup` rồi `npm run up` (hoặc `npm run desktop`).

## Dev

**Cần:** Node 20+, Rust (Tauri), API đang chạy trên **8000**.

```powershell
# Gốc repo
npm install --prefix desktop
npm run desktop          # Tauri + Vite
npm run desktop:ui       # chỉ browser http://localhost:5173
```

Hoặc trong `desktop/`:

```powershell
npm install
npm run dev
npm run dev:ui
```

Tuỳ chọn: tạo `desktop/.env` với `VITE_API_URL=http://127.0.0.1:8000/api` nếu cần đổi host/port.

## Build

```powershell
npm run desktop:build
# hoặc: cd desktop && npm run build
```

## Test

```powershell
npm run test:desktop
# (cần packages/ide-protocol đã npm install — setup làm sẵn)
```
