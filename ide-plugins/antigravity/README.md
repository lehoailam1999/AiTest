# AITest Antigravity Plugin

Extension cho **Antigravity IDE** — Semantic Context Bridge tới AITest Desktop.

## Chức năng

- WebSocket JSON-RPC trên `localhost` + token
- Ghi `~/.aitest/ide-bridge.json` với `ide: "antigravity"`
- Đẩy `focusChanged` khi caret/selection đổi
- Lệnh IDE: Definition, References, Implementations, Search, Read/Open file

## Cài đặt

Từ root repo:

```powershell
npm run extension:install
```

Script cài **plugin Antigravity** vào thư mục extensions của Antigravity IDE (không chồng lên Cursor).

Hoặc thủ công:

```powershell
cd ide-plugins/antigravity
npm install
npm run compile
npm run package
```

Trong Antigravity: **Extensions → Install from VSIX…** → Reload Window.

## Kiểm tra

1. Status bar: `AITest (Antigravity) :port`
2. File `%USERPROFILE%\.aitest\ide-bridge.json` có `"ide":"antigravity"`
3. AITest Desktop (`npm run desktop`) → **Unit test** → **Connect IDE**

## Lưu ý

- **Antigravity IDE plugin** và **Antigravity CLI** là hai thành phần khác nhau.
- Trong Cấu hình AI, chọn `Antigravity CLI`; AITest gọi lệnh `agy` đã đăng nhập
  trên máy và không lưu credential của vendor.
