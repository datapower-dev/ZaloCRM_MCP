# Kênh Tư Vấn · Ca khó · Claude Code (MCP) · Telegram bot

Tài liệu cho các tính năng thêm ngày 25/10/2026 trên nhánh `security-hardening`.

## Menu mới

| Menu | Ai thấy | Mục đích |
|------|---------|----------|
| Kênh Tư Vấn | quyền `channels.view` | Theo dõi nhóm và P2P: số lượt hỏi, hoạt động gần nhất, bật/tắt **Nghe tin nhắn**, **AI assist**, gán **Người hỗ trợ**, thao tác hàng loạt |
| Ca khó | mọi người (lọc theo quyền) | Danh sách yêu cầu phức tạp / cần duyệt; duyệt, từ chối, đánh dấu đã xử lý, gửi lại |
| Claude Code | mọi người (tạo token cần `claude.use`) | Token MCP cá nhân, lệnh kết nối, nhật ký gọi tool; admin quản lí mọi token |
| Cấu hình | owner/admin | MCP, Claude Code, Phân quyền, Telegram bot, Thời gian phản hồi, Kênh & Ca khó |

Thêm vào màn hình có sẵn:

- **Tin nhắn**: nút **Ca khó** ở đầu khung chat.
- **Tài khoản Zalo**: nút ★ chọn **Zalo quản lí** (mỗi tổ chức một tài khoản), cột Vai trò.
- **Dashboard API**: KPI thêm `overdueConversations`, `openEscalations`.
- **Chuông thông báo**: dùng thời gian cảnh báo trong Cấu hình thay cho 30 phút cố định, thêm số ca khó đang chờ.

## Kênh Tư Vấn

- **Nghe tin nhắn tắt**: tin mới của kênh bị bỏ qua hoàn toàn (không lưu, không thông báo, không webhook).
- Kênh mới mặc định theo Cấu hình → Kênh (nghe nhóm mới, nghe P2P mới, AI assist cho kênh mới).
- **AI assist bật**: kênh hiển thị với Claude Code khi “Chỉ kênh bật AI assist” đang bật (mặc định).
- Member thấy kênh của tài khoản Zalo được cấp quyền, hoặc kênh mình là người hỗ trợ.

## Ca khó

1. Nhân viên bấm **Ca khó** trong chat hoặc Kênh Tư Vấn, nhập tiêu đề, loại (phức tạp / cần duyệt), mức độ, chi tiết.
2. Hệ thống gửi tóm tắt kèm 5 tin gần nhất:
   - **Zalo quản lí**: nếu Cấu hình → Ca khó chọn một hội thoại/nhóm của Zalo quản lí, Zalo quản lí đăng vào đó; nếu để trống, Zalo của hội thoại nhắn trực tiếp tới Zalo quản lí.
   - **Telegram**: tới mọi chat đã liên kết, kèm nút ✅ Duyệt / ❌ Từ chối / ✔️ Đã xử lý (chỉ chat được tick “Được duyệt ca khó”).
3. Trạng thái gửi (đã gửi / lỗi / bỏ qua kèm lý do) lưu trên từng ca khó; có nút gửi lại.
4. Quản lí xử lý trên web, Telegram hoặc Claude Code; thay đổi đẩy realtime (Socket.IO) và webhook `escalation.created` / `escalation.updated`.

Tin gửi Zalo dùng chung giới hạn chống khoá (200 tin/ngày, 5 tin/30 giây mỗi tài khoản).

## Claude Code qua MCP

- Endpoint: `POST /mcp` (Streamable HTTP, stateless). Dev: `http://127.0.0.1:3000/mcp`; Docker: `APP_URL/mcp`; đổi bằng `MCP_PUBLIC_URL`.
- Mỗi nhân viên tạo **token cá nhân** `zcc_…` ở menu Claude Code; DB chỉ lưu SHA-256; token hiện một lần, có hạn dùng, thu hồi được.
- Kết nối:

```bash
claude mcp add --transport http zalocrm http://127.0.0.1:3000/mcp --header "Authorization: Bearer zcc_..."
```

- Tool: `crm_overview`, `list_channels`, `get_messages`, `search_contacts`, `get_contact`, `list_escalations` (read) · `update_contact`, `create_escalation`, `update_escalation` (write) · `send_message` (send).
- Mỗi request kiểm tra lại: token chưa thu hồi/hết hạn, tài khoản còn hoạt động, tổ chức bật Claude Code và MCP, người dùng còn quyền `claude.use`. Gỡ quyền là token ngừng hoạt động ngay.
- Scope `send` cần đồng thời: Cấu hình → MCP bật “gửi tin”, quyền `mcp.send`, quyền chat trên tài khoản Zalo. Mặc định tắt.
- Chặn request có header `Origin` lạ (trình duyệt) để chống CSRF/DNS rebinding; rate limit 120 lần/phút/IP; mọi lần gọi tool ghi vào `mcp_call_logs`.

## Phân quyền

Owner luôn có mọi quyền. Owner chỉnh ma trận cho admin và member trong Cấu hình → Phân quyền:

| Quyền | Admin mặc định | Member mặc định |
|-------|:-:|:-:|
| `channels.view` Xem Kênh Tư Vấn | ✓ | ✓ |
| `channels.manage` Bật/tắt kênh, gán người hỗ trợ | ✓ | |
| `escalations.create` Chuyển Ca khó | ✓ | ✓ |
| `escalations.resolve` Duyệt / xử lý Ca khó | ✓ | |
| `claude.use` Dùng Claude Code | ✓ | |
| `mcp.send` Claude Code gửi tin Zalo | | |

Cấu hình → Claude Code cho phép owner cấp `claude.use` cho từng người.

## Telegram bot

1. Tạo bot bằng @BotFather, dán token vào Cấu hình → Telegram bot (token mã hoá AES-GCM trong DB).
2. Bấm **Liên kết chat mới** → mở link `t.me/<bot>?start=<mã>` hoặc gửi `/start <mã>` trong nhóm (mã dùng một lần, hết hạn 10 phút).
3. Lệnh: `/tongquan` (tổng quan dashboard), `/cakho` (ca khó đang chờ + nút duyệt), `/quahan` (hội thoại quá hạn), `/help`.
4. Tự động: báo ca khó mới, báo hội thoại quá hạn (mỗi 5 phút, trong giờ làm), tổng quan 08:00.

Bot dùng long polling nên không cần mở cổng hay URL công khai. Chat chưa liên kết không nhận được dữ liệu.

## Thời gian phản hồi

Cấu hình → Thời gian phản hồi: phút cảnh báo chưa trả lời (màu cam, chuông), phút quá hạn (màu đỏ, KPI, Telegram), giờ làm việc (giờ Việt Nam), bật/tắt báo Telegram.

## Kiểm thử

```bash
cd backend && node --env-file=.env --import tsx test/e2e-features.mjs
```

72 kiểm tra (phân quyền, kênh, ca khó, MCP qua client chính thức, Telegram), chạy lặp lại được. `test/mcp-smoke.mjs` thử nhanh MCP như Claude Code.

## Giả định và giới hạn

- “Claude Code trong ứng dụng” được làm theo hướng ứng dụng là **máy chủ MCP** để Claude Code trên máy nhân viên kết nối; ứng dụng không tự chạy Claude Code CLI trên server (tránh cấp quyền shell cho web).
- Chưa có “Trả lời tự động” như ảnh mẫu: cần nối một mô hình AI và quy tắc trả lời, là việc riêng.
- Gửi ca khó qua Zalo cần Zalo quản lí và Zalo của hội thoại đều đang kết nối; nhắn trực tiếp giữa hai tài khoản có thể bị Zalo hạn chế nếu chưa là bạn bè, nên khuyến nghị chọn một nhóm quản lí.
- Telegram mỗi tổ chức một bot; nếu chạy hai bản backend cùng token, Telegram trả lỗi 409 (bot tự thử lại).
