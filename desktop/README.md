# AITest Desktop (React + Tauri)

Desktop shell: **Tauri v1** + **React (Vite)** gọi **Python API**.

## Scope

- **M4:** Desktop scaffold, Startup / Login / Home
- **M5+:** Import source, Generate Unit, Run Test (Tauri commands đã có sẵn trong Rust)

## Dev

Prerequisites:

- Rust toolchain
- Node.js 20+
- Python API trên `http://localhost:5000`

```bash
cd desktop
npm install
npm run dev:ui          # chỉ React (http://localhost:5173)
npm run dev             # Tauri + React
```

`VITE_API_URL` mặc định: `http://localhost:5000/api` (file `.env`).

## Build

```bash
cd desktop
npm run build:ui
npm run build
```

## Tauri commands (Rust)

`src-tauri/src/commands.rs`: `pick_project_folder`, `scan_project`, `list_cs_files`, `read_text_file`, `write_text_file`, `run_dotnet_test`.
