# Hướng dẫn Triển khai lên cPanel (Node.js)

Dưới đây là quy trình chi tiết để deploy công cụ **IMAP Sync Tool** lên hosting cPanel sử dụng tính năng "Setup Node.js App".

## 1. Chuẩn bị Mã nguồn
Bạn cần chuẩn bị các file sau để upload. Tốt nhất là nén toàn bộ thành file `source.zip` (trừ `node_modules` và `.git`).

**Danh sách file cần thiết:**
- `app.js` (File chạy chính)
- `package.json` (Khai báo thư viện)
- `templates/` (Thư mục giao diện, chứa `index.html`)

> ⚠️ **Lưu ý:** TUYỆT ĐỐI KHÔNG upload thư mục `node_modules`. Bạn sẽ cài đặt nó trên server.

## 2. Upload lên Hosting
1. Đăng nhập vào **cPanel**.
2. Mở **File Manager**.
3. Tạo một thư mục mới để chứa code, ví dụ: `imap_tool`.
   - *Lưu ý: Nên để ngoài thư mục `public_html` để bảo mật hơn, hoặc trong `public_html` nếu bạn muốn dễ quản lý.*
4. Upload file `source.zip` vào thư mục đó và **Extract** (Giải nén).

## 3. Cấu hình Node.js App
1. Quay lại trang chủ cPanel, tìm mục **Software** -> chọn **Setup Node.js App**.
2. Nhấn nút **Create Application**.
3. Điền các thông số:
   - **Node.js Version**: Chọn phiên bản mới nhất (ví dụ `18.x`, `20.x` hoặc `22.x`).
   - **Application Mode**: Chọn `Production`.
   - **Application Root**: Nhập tên thư mục bạn vừa tạo (ví dụ: `imap_tool`).
   - **Application URL**: Chọn tên miền (domain) hoặc subdomain bạn muốn chạy tool.
   - **Application Startup File**: Nhập `app.js`.
4. Nhấn nút **Create**.

## 4. Cài đặt Thư viện (NPM Install)
1. Sau khi App được tạo, màn hình sẽ chuyển sang giao diện quản lý App.
2. Nếu Node.js App phát hiện file `package.json`, nút **Run NPM Install** sẽ hiện ra.
3. Nhấn **Run NPM Install** và đợi vài giây để hệ thống tải các thư viện về.
   - *Nếu nút bị mờ hoặc không hoạt động:*
     - Copy dòng lệnh `source /home/username/...` ở khung "Enter to the virtual environment".
     - Mở **Terminal** trong cPanel (hoặc SSH).
     - Paste dòng lệnh đó vào để kích hoạt môi trường ảo.
     - Chạy lệnh: `npm install`

## 5. Hoàn tất & Kiểm tra
1. Nhấn nút **Restart Application** để khởi động lại tiến trình Node.js.
2. Truy cập vào đường dẫn website (Application URL) đã đăng ký.
3. Nếu thấy giao diện **IMAP Sync Pro** hiện ra là thành công!

---

## 🛠 Xử lý lỗi thường gặp (Troubleshooting)

### Lỗi 500 / 503 Service Unavailable
- **Nguyên nhân**: Code bị lỗi crash hoặc chưa cài đủ thư viện.
- **Cách sửa**:
  1. Vào **File Manager**, tìm trong thư mục app xem có file `stderr.log` không. Mở ra xem lỗi chi tiết.
  2. Đảm bảo đã chạy `npm install` thành công.
  3. Đảm bảo file `app.js` là file khởi động (Startup File).

### Lỗi "Incomplete response received from application"
- Đây thường là do tiến trình Node.js bị treo hoặc khởi động quá lâu.
- Hãy thử Restart lại App.

### Lỗi Giao diện không hiện (404)
- Kiểm tra lại cấu trúc thư mục. File `index.html` PHẢI nằm trong thư mục `templates/` (tức là `imap_tool/templates/index.html`).
