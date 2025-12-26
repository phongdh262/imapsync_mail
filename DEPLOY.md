# Hướng dẫn Triển khai lên cPanel (Node.js)

Dưới đây là các bước để đưa công cụ này lên hosting cPanel có hỗ trợ Node.js.

## 1. Chuẩn bị File
Bạn cần upload các file/thư mục sau lên thư mục chứa web (ví dụ `public_html/tools_mail` hoặc một thư mục riêng):
- `app.js`
- `package.json`
- `templates/` (Chứa `index.html`)

> **Lưu ý:** Không cần upload thư mục `node_modules`.

## 2. Cấu hình Node.js trên cPanel
1. Đăng nhập vào cPanel.
2. Tìm và chọn mục **Setup Node.js App** (thường trong phần Software).
3. Nhấn **Create Application**.
4. Điền thông tin:
   - **Node.js Version**: Chọn phiên bản 18.x hoặc 20.x.
   - **Application Mode**: Production.
   - **Application Root**: Nhập đường dẫn thư mục bạn vừa upload (ví dụ: `tools_mail`).
   - **Application URL**: Chọn domain/subdomain của bạn.
   - **Application Startup File**: Nhập `app.js`.
5. Nhấn **Create**.

## 3. Cài đặt thư viện (Dependencies)
1. Sau khi tạo xong, ở trang cấu hình App, kéo xuống dưới.
2. Bạn sẽ thấy nút **Run NPM Install**. Nhấn vào đó để hệ thống tự tải các thư viện về.
3. Nếu không thấy nút này, bạn hãy copy dòng lệnh "Enter to the virtual environment..." (bắt đầu bằng `source...`), paste vào **Terminal** của cPanel, sau đó gõ: `npm install`.

## 4. Khởi động
1. Quay lại trang **Setup Node.js App**.
2. Nhấn nút **Restart Application**.
3. Truy cập vào đường dẫn website của bạn để kiểm tra.

## Xử lý lỗi thường gặp
- **Lỗi 500/503**: Vào File Manager, tìm file `stderr.log` trong thư mục code để xem lỗi chi tiết.
- **Trắng trang/Lỗi kết nối**: Kiểm tra lại xem đã cài đủ thư viện chưa (`npm install`).
