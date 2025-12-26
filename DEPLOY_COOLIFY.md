# Hướng dẫn Triển khai lên Coolify (VPS)

Coolify là công cụ quản lý VPS tuyệt vời giúp bạn deploy ứng dụng dễ dàng giống như Vercel hay Heroku. Dưới đây là các bước để deploy ứng dụng Node.js này.

## 1. Chuẩn bị Mã nguồn

1.  **Đẩy code lên Git**: Đảm bảo mã nguồn của bạn đã được push lên GitHub, GitLab hoặc Bitbucket.
    *   Nếu chưa có repo, hãy tạo một repo mới trên GitHub.
    *   Chạy các lệnh sau trong thư mục dự án của bạn (nếu chưa init):
        ```bash
        git init
        git add .
        git commit -m "Initial commit"
        # Thay URL bằng URL repo của bạn
        git remote add origin https://github.com/username/tools_mail.git
        git push -u origin main
        ```

2.  **Kiểm tra file quan trọng**:
    *   `package.json`: Đã có script `"start": "node app.js"`.
    *   `app.js`: Đã được cập nhật để dùng `process.env.PORT` (đã thực hiện).

## 2. Tạo Project trên Coolify

1.  Truy cập vào trang quản trị Coolify của bạn (ví dụ: `http://vps-ip:3000` hoặc domain bạn đã cài).
2.  Nếu chưa có **Project**, hãy tạo một Project mới.
3.  Trong Project, nhấn **New** -> **Public Repository** (hoặc Private nếu repo của bạn ẩn).
4.  Dán link Git Repository của bạn vào.
    *   Ví dụ: `https://github.com/yourname/tools_mail`
5.  Nhấn **Check Repository**.

## 3. Cấu hình Dịch vụ (Service)

Coolify sẽ tự động phát hiện đây là ứng dụng **Node.js** và khuyên dùng **Nixpacks** hoặc **Heroku** build pack. **Nixpacks** là lựa chọn tốt nhất.

1.  **Configuration**:
    *   **Name**: `imap-sync` (hoặc tên tùy thích).
    *   **Branch**: `main` (hoặc `master`).
    *   **Build Pack**: `Nixpacks` (Mặc định).
    *   **Port**: `3000` (Coolify thường tự nhận diện).

2.  **Environment Variables (Biến môi trường)**:
    *   Nhấn vào tab **Environment Variables**.
    *   Thêm biến `PORT` với giá trị `3000` (để đảm bảo đồng bộ, dù Coolify thường tự set).
    *   Nếu bạn muốn ứng dụng hoạt động trên domain cụ thể ngay lập tức, hãy cấu hình trong phần **General** -> **Domains** (ví dụ: `https://tools.yourdomain.com`). Đừng quên trỏ DNS A record của domain về IP của VPS.

## 4. Deploy

1.  Nhấn nút **Deploy** ở góc trên.
2.  Chờ quá trình **Build** và **Deploy** hoàn tất. Bạn có thể xem logs trong tab **Logs**.
3.  Sau khi deploy thành công (Status: **Running**), bạn có thể truy cập vào URL đã cấu hình (hoặc URL mặc định Coolify tạo cho bạn nếu có).

## 5. Lưu ý quan trọng

*   **Dữ liệu (Logs)**: Mặc định, mỗi lần deploy lại, Coolify (qua Docker) có thể sẽ reset lại filesystem (trừ khi bạn cấu hình Persistent Storage). Điều này có nghĩa là các file log trong thư mục `logs/` **sẽ bị mất** sau mỗi lần deploy mới.
    *   *Giải pháp*: Nếu cần giữ logs lâu dài trên VPS, bạn cần vào mục **Storage** trong Coolify, map thư mục `/app/logs` của container ra một đường dẫn trên VPS.
*   **Persistent Storage (Cấu hình lưu trữ)**:
    *   Vào tab **Storage**.
    *   Thêm mới:
        *   **Volume Name**: (tự đặt)
        *   **Destination Path (trong container)**: `/app/logs`
    *   Nhấn Save và **Redeploy** để áp dụng.

## 6. Sửa lỗi thường gặp

*   **Build thất bại**: Kiểm tra tab **Build Logs**. Thường do lỗi cú pháp code hoặc thiếu dependencies.
*   **Deploy thành công nhưng không vào được**:
    *   Kiểm tra tab **Application Logs**.
    *   Đảm bảo cổng `3000` được mở (nếu không dùng domain/proxy của Coolify). Tuy nhiên, nếu dùng domain qua Coolify thì Coolify đã tự lo việc proxy rồi, không cần mở port thủ công trên firewall VPS (trừ port 80/443).
