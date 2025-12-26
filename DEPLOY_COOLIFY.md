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

Bạn có 2 cách để kết nối, tùy thuộc vào Repository của bạn là **Public** (Công khai) hay **Private** (Riêng tư).

### Cách 1: Dùng "Public Repository" (Khuyên dùng nếu Repo Public)
Đây là cách đơn giản nhất, **không cần cấu hình GitHub App**.

1.  Truy cập Dashboard Coolify.
2.  Tạo **Project** mới (hoặc vào project có sẵn).
3.  Chọn môi trường (Environment), ví dụ **Production**.
4.  Nhấn nút **+ New** -> Chọn **Public Repository**.
5.  Dán link Git của bạn vào: `https://github.com/phongdh262/imapsync_mail`
6.  Nhấn **Check Repository** và tiếp tục sang bước 3.

### Cách 2: Dùng "Private Repository" (Nếu Repo Private)
Nếu repo là riêng tư, bạn cần cấp quyền truy cập cho Coolify.

*   **Cách đơn giản**: Chọn **Private Repository (with Deploy Key)**. Coolify sẽ cấp cho bạn một `Deploy Key`. Bạn copy key này, vào GitHub Repo -> Settings -> Deploy Keys -> Add Deploy Key.
*   **Cách nâng cao (GitHub App)**: Nếu bạn đang ở màn hình cấu hình "GitHub Source" (như ảnh bạn gửi):
    *   **Organization**: Điền tên user GitHub của bạn (ví dụ: `phongdh262`). **Không điền URL đầy đủ**.
    *   **App ID, Client ID, Client Secret**: Bạn cần vào GitHub -> Settings -> Developer Settings -> GitHub Apps -> New GitHub App để tạo và lấy các thông tin này. (Cách này rất phức tạp, chỉ nên dùng nếu bạn quản lý nhiều repo).

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
