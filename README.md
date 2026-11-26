# Thiên Ân · Quản lý thu nhập

Ứng dụng cục bộ dùng ReactJS + TypeScript + TailwindCSS, Rust/Axum và SQLite/SQLx. Thiết kế tham chiếu `DESIGN-cal.md`: nền trắng, nút đen, thẻ bo 12px, font Inter hoặc font hệ thống dự phòng.

## Chạy ứng dụng

Cần Node.js 22 trở lên, Rust stable và compiler C tương ứng. Trên Windows MSVC, cài Visual Studio Build Tools với workload Desktop development with C++, rồi chạy trong Developer PowerShell. Không cần cài SQLite riêng.

Terminal frontend:

```powershell
cd frontend
npm ci
npm run dev
```

Terminal backend:

```powershell
cd backend
cargo run -- --create-admin
cargo run
```

Mở http://127.0.0.1:5173 và đăng nhập bằng mã được in khi chạy `--create-admin`. Trên máy hiện tại có thể dùng `./scripts/backend.ps1 -Action create-admin` từ thư mục gốc. SQLite lưu SHA-256 của mã ngẫu nhiên trong `admin_access_codes`, không lưu mã rõ; mã gốc chỉ hiển thị lúc tạo. Trình duyệt lưu mã trong sessionStorage của tab. Mỗi API kiểm tra database, nên đặt `revoked_at` của mã sẽ thu hồi quyền ngay. Có thể cung cấp `THIEN_AN_TOKEN` (ít nhất 16 ký tự) để nhập một mã vào database lúc khởi động; mã đã thu hồi không tự được kích hoạt lại. Bản hiện tại dùng quyền quản trị chung, chưa có phân quyền nhân viên. Chỉ bind localhost mặc định.

Trên máy hiện tại có sẵn môi trường LLVM portable đã chuẩn bị để kiểm thử. Từ thư mục gốc, dùng `./scripts/backend.ps1 -Action run` thay cho `cargo run`, hoặc `-Action test` để chạy kiểm thử. Script không tải hay cài phần mềm; chỉ chọn LLVM khi tìm thấy trong thư mục tạm, nếu không dùng Cargo mặc định. Có thể chỉ định đường dẫn `bin` của LLVM MinGW bằng `THIEN_AN_LLVM_BIN`; cần toolchain `stable-x86_64-pc-windows-gnullvm`. Khi thư mục tạm bị dọn, cần cung cấp compiler lại hoặc dùng Build Tools như trên.

Build và phục vụ cùng một origin:

```powershell
cd frontend
npm run build
cd ../backend
cargo run --release
```

Sau đó mở http://127.0.0.1:3001. Chạy backend từ thư mục `backend` để tìm đúng đường dẫn frontend. `DATABASE_URL` mặc định là `sqlite://thien-an.db`; `THIEN_AN_BIND` mặc định `127.0.0.1:3001`.

## Trợ lý AI

Trang **Trợ lý AI** yêu cầu đăng nhập bằng mã quản trị hiện có. Backend dùng Gemini 3.5 Flash-Lite và tra cứu SQLite bằng các tool chỉ đọc. Lịch sử chat giữ trong bộ nhớ của tab khi chuyển trang.

Ở **Cài đặt**, bạn có thể lưu khóa Gemini cho trình duyệt hiện tại và chọn cỡ chữ trang Admin. Khóa được lưu trong localStorage, dùng trên HTTPS hoặc localhost, và ưu tiên hơn khóa cấu hình máy chủ. Nút **Xóa khóa đã lưu** xóa khóa khỏi trình duyệt. Tránh lưu khóa trên máy dùng chung.

Để thử với Gemini, khởi động backend với một cơ sở dữ liệu giả lập. Cấu hình khóa Gemini qua biến môi trường của tiến trình máy chủ:

```powershell
$env:DATABASE_URL = 'sqlite://demo.db'
$env:GEMINI_API_KEY = '<khóa Gemini của bạn>'
$env:THIEN_AN_AI_ALLOW_DATA = 'true'
./scripts/backend.ps1 -Action run
```

Tạo mã quản trị cho database thử bằng `./scripts/backend.ps1 -Action create-admin` với cùng `DATABASE_URL`. Máy chủ chỉ gửi câu hỏi, lịch sử ngắn và kết quả tra cứu đã chọn sang Gemini khi `THIEN_AN_AI_ALLOW_DATA=true`. Điều kiện này áp dụng cho cả khóa cấu hình trên máy chủ và khóa lưu trong trình duyệt. Bật cho dữ liệu thật sau khi xác nhận gói dịch vụ và chính sách xử lý dữ liệu phù hợp. Dùng câu hỏi và dữ liệu giả lập trên Free Tier.

## Dữ liệu mẫu

Database mới mặc định trống. Chỉ khi muốn xem minh họa, chạy từ `backend`:

```powershell
cargo run -- --seed
```

Lệnh này thêm 32 giao dịch có mã `TA-DEMO`, có thể chạy lại mà không trùng. Không chạy trên database thật. Cấu hình `DATABASE_URL=sqlite://demo.db` để dùng database minh họa riêng.

## Nghiệp vụ

- Tiền là số nguyên VND, mỗi khoản từ 1 đến 100 tỷ đồng.
- Tổng đã thu chỉ cộng trạng thái `paid`; `pending`, `failed` không được cộng.
- Thu nhập ròng = tiền đã thu trong kỳ trừ tiền hoàn thực hiện trong kỳ. Đây là tiền thực thu, không phải lợi nhuận hoặc doanh thu phân bổ thời hạn gói.
- Hoàn tiền chỉ áp dụng khoản đã thu. Hỗ trợ hoàn một phần, nhiều lần; tổng hoàn không vượt tiền gốc. Transaction `BEGIN IMMEDIATE` bảo vệ kiểm tra số dư khi đồng thời hoàn tiền.
- Hoàn tiền thuộc kỳ thực hiện hoàn, kể cả khoản gốc thuộc kỳ trước. Bộ lọc nguồn thu, phương thức, trạng thái và tìm kiếm áp dụng theo khoản gốc.
- Ngày lọc tính theo giờ Việt Nam, bao gồm cả hai ngày biên; thời điểm lưu UTC.
- Mỗi yêu cầu tạo thu hoặc hoàn có idempotency key. Gửi lại cùng nội dung không tạo thêm bản ghi. Dùng lại khóa với nội dung khác trả lỗi HTTP 409. Lịch sử tạo thu và hoàn lưu ở `audit_log`.
- Biểu đồ, tổng quan, bảng và CSV dùng chung hàm lọc; CSV xuất toàn bộ kết quả, không chỉ trang đang xem, có cả các dòng hoàn tiền. CSV có BOM UTF-8 và xử lý công thức bảng tính.
- Bảng 10 dòng/trang. Bản đầu tiên tổng hợp dữ liệu trong bộ nhớ backend; cần chuyển sang aggregation SQL khi lịch sử giao dịch tăng lớn.
- Khoản chờ có thể xác nhận đã thu trong chi tiết giao dịch; tiền được tính vào ngày xác nhận thực tế. Không tích hợp ngân hàng, chi phí, hóa đơn điện tử hay tính lợi nhuận.

## Kiểm thử

```powershell
cd backend
cargo test
cargo fmt --check
cd ../frontend
npm run build
```

Kiểm thử trình duyệt dùng Microsoft Edge đã cài. Khởi động backend ở port 3001 với database kiểm thử riêng và token `local-test-token-2026`, sau đó chạy `npm run test:e2e` trong `frontend`. Playwright tự khởi động Vite ở 4173. Test tạo khoản thu và hoàn tiền thật trong database kiểm thử.

## Sao lưu và khôi phục

SQLite bật WAL, foreign keys và busy timeout 10 giây. Dùng SQLite backup API để tạo bản sao nhất quán, kể cả khi server đang chạy:

```powershell
python scripts/backup.py backend/thien-an.db backups/thien-an-backup.db
```

Lệnh kiểm tra integrity trước khi báo thành công và từ chối ghi đè backup cũ. Để khôi phục: dừng server, giữ bản sao database hiện tại cùng các tệp WAL/SHM, kiểm tra bản backup bằng SQLite `PRAGMA integrity_check`, rồi dùng một đường dẫn database mới với `DATABASE_URL`. Không thay tệp database đang mở. Chạy ứng dụng và đối chiếu tổng thu, hoàn tiền trước khi sử dụng lại.
