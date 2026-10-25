# Nâng cấp bảo mật ZaloCRM (nhánh `security-hardening`)

Tài liệu này mô tả các thay đổi so với bản gốc `tekarratter/ZaloCRM` (commit `d186fd2`) sau khi rà soát
mã nguồn ngày 25/10/2026, và cách chạy an toàn trên máy cá nhân (host local).

Kết luận rà soát: **không có mã ẩn gửi dữ liệu ra ngoài**. Kết nối ra ngoài duy nhất là máy chủ Zalo
(qua thư viện `zca-js`) và webhook do chính bạn cấu hình. Các lỗ hổng tìm thấy nằm ở thiết kế và đã được sửa dưới đây.

## 1. Những gì đã sửa

| # | Vấn đề gốc | Mức | Cách sửa | File |
|---|-----------|-----|----------|------|
| 1 | Socket.IO không xác thực, broadcast toàn bộ tin nhắn cho mọi kết nối | Nghiêm trọng | Socket phải gửi JWT (`auth.token`); tự vào room `org:<orgId>`; mọi sự kiện chỉ emit vào room của tổ chức; `zalo:subscribe` kiểm tra tài khoản thuộc org | `zalo-socket.ts`, `zalo-pool.ts`, `zalo-listener-factory.ts`, `chat-routes.ts`, `appointment-reminder.ts`, frontend `use-chat.ts`, `use-zalo-accounts.ts` |
| 2 | `JWT_SECRET`/`ENCRYPTION_KEY` có giá trị mặc định khi `.env` trống | Nghiêm trọng | Server **từ chối khởi động** nếu thiếu, trùng placeholder hoặc < 32 ký tự | `config/index.ts` |
| 3 | Cookie phiên Zalo lưu plaintext trong DB và trong backup | Nghiêm trọng | Mã hoá AES-256-GCM (khoá dẫn xuất từ `ENCRYPTION_KEY` bằng scrypt). Bản ghi cũ dạng rõ được tự mã hoá khi khởi động | `shared/utils/crypto.ts`, `zalo/zalo-session.ts`, `app.ts` |
| 4 | Member thường đổi được webhook URL và tạo API key (kênh rò rỉ toàn bộ tin nhắn) | Nghiêm trọng | Toàn bộ route `/settings/webhook*`, `/settings/api-key*` yêu cầu owner/admin; frontend ẩn/khoá với member | `webhook-settings-routes.ts`, `router/index.ts`, `ApiSettingsView.vue` |
| 5 | API key lưu plaintext | Cao | Lưu SHA-256 (`public_api_key_hash`) + gợi ý hiển thị; key chỉ hiện **một lần** khi tạo; key cũ dạng rõ được tự nâng cấp lần dùng đầu; thêm nút thu hồi | `webhook-settings-routes.ts`, `public-api-routes.ts` |
| 6 | SSRF: webhook URL trỏ được tới `127.0.0.1`, `db:5432`, metadata cloud | Trung bình | Kiểm tra scheme, chặn credentials trong URL, phân giải DNS và chặn dải private/loopback/link-local, không theo redirect; kiểm tra lại mỗi lần gửi | `shared/utils/url-guard.ts`, `webhook-service.ts` |
| 7 | Bypass rate-limit bằng header `x-api-key` ngẫu nhiên | Trung bình | Rate-limit theo IP; thêm giới hạn riêng `/auth/login` 10 lần/phút, `/setup` 5 lần/phút; ghi log đăng nhập thất bại | `app.ts`, `auth-routes.ts` |
| 8 | IDOR: sửa/xoá đơn hàng bất kỳ không kiểm tra org | Trung bình | Kiểm tra `orgId`; member chỉ sửa/xoá đơn do mình tạo; kiểm tra contact thuộc org, số tiền hợp lệ | `order-routes.ts` |
| 9 | Phân quyền Zalo thiếu ở nhiều route | Trung bình | `requireZaloAccess` cho xem hội thoại, đánh dấu đã đọc, login/reconnect/xoá tài khoản Zalo; member chỉ thấy tài khoản được cấp; tạo tài khoản Zalo cần owner/admin; sync kiểm tra org | `chat-routes.ts`, `zalo-routes.ts`, `zalo-sync-routes.ts` |
| 10 | Mật khẩu yếu, admin sửa được owner | Trung bình | Chính sách ≥ 8 ký tự có chữ và số, chặn mật khẩu phổ biến; admin không sửa/đặt lại mật khẩu owner; không tạo thêm owner; bcrypt cost 12 | `auth/password-policy.ts`, `user-routes.ts`, `auth-routes.ts`, `SetupView.vue` |
| 11 | Error handler trả thông điệp lỗi nội bộ (Prisma/SQL) cho client | Thấp | Lỗi ≥ 500 chỉ trả `Internal Server Error`, chi tiết ghi log server | `app.ts` |
| 12 | Public API: không log, không giới hạn độ dài, không rate-limit Zalo | Thấp | Log mọi lời gọi (org, method, path, IP); giới hạn 4000 ký tự; dùng cùng bộ chống block Zalo; có thể tắt bằng `PUBLIC_API_ENABLED=false` | `public-api-routes.ts` |
| 13 | JWT 7 ngày, không cấu hình | Thấp | Mặc định 1 ngày, đổi bằng `JWT_EXPIRES_IN` | `config/index.ts` |
| 14 | CORS/Socket.IO dev mở cho mọi origin | Thấp | Chỉ chấp nhận `APP_URL` + `CORS_ORIGINS` | `app.ts` |
| 15 | Docker publish `0.0.0.0:3080`, chạy root | Thấp | Mặc định bind `127.0.0.1` (đổi bằng `BIND_ADDR`), `cap_drop: ALL`, chạy user `node`, không `npx` lúc khởi động | `docker-compose.yml`, `docker/Dockerfile` |
| 16 | `zca-js` gọi npm registry kiểm tra phiên bản | Thấp | `checkUpdate: false` | `zalo-pool.ts` |
| 17 | Bug: tìm kiếm chọn trường `diseaseCode` không tồn tại → luôn lỗi 500 | Bug | Bỏ trường thừa | `search-routes.ts` |
| 18 | Bug: màn API Settings dùng sai tên trường (`webhookUrl`/`apiKey`) so với backend | Bug | Đồng bộ `url`/`secret`/`key` | `ApiSettingsView.vue` |
| 19 | Bug: nút "Kết nối lại" không bao giờ hiện vì API không trả `sessionData` | Bug | API trả `hasSession: boolean` (không bao giờ trả cookie) | `zalo-routes.ts`, `ZaloAccountsView.vue` |

Thêm header bảo mật cơ bản (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`), giới hạn body 1 MB,
giới hạn phân trang ≤ 200 bản ghi.

## 2. Chạy trên máy cá nhân (Windows + Docker Desktop)

1. Tạo cấu hình:
   ```bash
   copy .env.example .env
   ```
2. Sinh 2 secret và điền vào `.env` (chạy lệnh 2 lần, mỗi kết quả dán vào một biến):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Điền `JWT_SECRET`, `ENCRYPTION_KEY`, `DB_PASSWORD`. Giữ `APP_URL=http://localhost:3080` và `BIND_ADDR=127.0.0.1`.
3. Khởi động:
   ```bash
   docker compose up -d --build
   ```
4. Mở `http://localhost:3080`, tạo tài khoản owner (mật khẩu ≥ 8 ký tự, có chữ và số).

Ứng dụng chỉ nghe trên `127.0.0.1`, máy khác trong mạng không truy cập được. Muốn mở ra LAN tin cậy:
đặt `BIND_ADDR=0.0.0.0`, `APP_URL=http://<IP-máy>:3080` (hoặc thêm vào `CORS_ORIGINS`). Muốn truy cập từ
Internet: đặt sau reverse proxy có TLS (nginx/Caddy/cloudflared) và `TRUST_PROXY=true`.

Chạy không Docker (dev): `backend/.env.example` → `backend/.env` (đã tạo sẵn trên máy này, trỏ tới database
`zalocrm` / role `zalocrm` trên PostgreSQL 17 local, tách biệt với `workhub`). Lệnh:

```bash
cd backend && npm run dev:local      # nạp backend/.env, cổng 3000
cd frontend && npm run dev           # cổng 5173, proxy /api và /socket.io về 3000
```

Mở http://localhost:5173. Trong Claude Code có sẵn `.claude/launch.json` (zalocrm-backend, zalocrm-frontend).

## 3. Lưu ý khi nâng cấp từ bản gốc

- **Dữ liệu cũ**: không đổi schema. Phiên Zalo dạng rõ được mã hoá tự động lần khởi động đầu. API key cũ
  vẫn dùng được và tự chuyển sang dạng băm sau lần gọi đầu; nên tạo key mới để chắc chắn.
- **ENCRYPTION_KEY** là khoá giải mã phiên Zalo: đổi khoá → mọi tài khoản Zalo phải đăng nhập QR lại.
  Sao lưu `.env` cùng với backup DB.
- **Backup**: thư mục `./backups` chứa dump DB (đã mã hoá cột phiên Zalo, nhưng còn thông tin khách hàng).
  Bảo vệ thư mục này như dữ liệu nhạy cảm.
- Frontend phải build lại (`docker compose up --build`) vì Socket.IO nay yêu cầu token.

## 4. Kiểm thử

```bash
cd backend && npx tsc --noEmit
cd frontend && npx vue-tsc -b
cd backend && npm run test:security
```

Kiểm thử đầu-cuối trên backend đang chạy (72 kiểm tra: setup, login, JWT, phân quyền owner/admin/member,
SSRF, API key băm + nâng cấp key cũ, public API, IDOR đơn hàng, quyền Zalo, mã hoá phiên trong cột DB,
Socket.IO từ chối không token và cách ly theo tổ chức, rate-limit đăng nhập):

```bash
cd backend && node --env-file=.env --import tsx test/e2e-local.mjs
```

Kết quả ngày 25/10/2026 trên PostgreSQL 17 local: 72/72 đạt (sau khi sửa 2 kiểm tra viết sai).

`test/security-units.ts` kiểm tra mã hoá/giải mã, phát hiện giả mạo ciphertext, đọc phiên cũ dạng rõ,
bộ lọc SSRF (loopback, private, link-local, IPv6, credentials, scheme) và chính sách mật khẩu.

## 5. Còn lại chưa xử lý (chấp nhận rủi ro có chủ đích)

- Token JWT vẫn lưu `localStorage` (không phát hiện điểm XSS nào; đã rút hạn xuống 1 ngày). Muốn chặt hơn: chuyển sang cookie `HttpOnly` + CSRF token.
- Member vẫn xem được danh bạ, lịch hẹn, đơn hàng của toàn tổ chức (đúng thiết kế CRM nhóm nhỏ).
- Tự động hoá Zalo cá nhân qua thư viện không chính thức có thể bị Zalo khoá tài khoản; đây là rủi ro nghiệp vụ, không phải lỗi mã.
- Chưa có 2FA, chưa có khoá tài khoản sau N lần sai (đã có rate-limit theo IP).
