# Kế hoạch Standard · Trợ lý AI Thiên Ân

Thêm trang **Trợ lý AI** vào ứng dụng quản lý thu nhập. Quản trị viên có thể hỏi bằng tiếng Việt, tra cứu giao dịch và đối chiếu số liệu theo kỳ. Giữ ReactJS, TailwindCSS, Rust/Axum và SQLite.

## Điểm tích hợp hiện tại

- `frontend/src/main.tsx` quản lý phiên bằng Bearer token, hiển thị sidebar và tải tổng quan. `frontend/src/style.css` ẩn sidebar trên màn hình dưới 768px.
- `backend/src/main.rs` xác thực mã quản trị qua SQLite, đăng ký API và phục vụ frontend đã build. Luồng tổng quan hiện đọc dữ liệu trước khi lọc trong Rust. Truy vấn agent cần lọc và tổng hợp ngay trong SQLite để xử lý lịch sử lớn.
- `backend/migrations/001_initial.sql` định nghĩa giao dịch và hoàn tiền. Dùng cùng quy tắc với trang Thu nhập: số tiền nguyên VND, ngày theo giờ Việt Nam, tổng thu chỉ tính `paid`, hoàn tiền theo ngày thực hiện hoàn kể cả khi giao dịch gốc khác kỳ.
- GitNexus đã xác định `App`, `router`, `auth` và luồng `overview → data → matches`. Bằng chứng đối chiếu từ working tree. Repository chưa có commit đầu tiên nên tài liệu này không có gói provenance schema 2 cho `gitnexus-work`.

## 1. Điều hướng và giao diện

- Thêm mục **Trợ lý AI** vào sidebar, trỏ đến `/tro-ly-ai`. Hiện trạng thái đang chọn và cung cấp điều hướng tương ứng trong topbar trên di động. Hỗ trợ tải lại, mở URL trực tiếp và nút quay lại của trình duyệt. Axum phục vụ `index.html` ở route trang chat, giữ cách xử lý lỗi của các đường dẫn API.
- Tạo `frontend/src/AssistantPage.tsx`. Dùng khung nền, kiểu chữ và khoảng cách theo `DESIGN-cal.md`, một cột hội thoại, ô soạn tin ở cuối, nút gửi và **Cuộc trò chuyện mới**. Enter gửi, Shift+Enter xuống dòng, tôn trọng IME khi đang gõ tiếng Việt. Hiển thị trạng thái đang tra cứu, dừng, lỗi có thể thử lại và thiếu cấu hình Gemini.
- Lưu các tin nhắn trong bộ nhớ của tab khi chuyển giữa Thu nhập và Trợ lý. Xóa khi đăng xuất hoặc mở cuộc trò chuyện mới. Hủy lượt đang chạy khi rời trang hoặc đăng xuất. Nội dung model được hiển thị dưới dạng văn bản hoặc Markdown đã vô hiệu hóa HTML thô. Giữ bộ lọc Thu nhập khi quay lại trang.

## 2. API và vòng lặp agent

- Thêm `POST /api/assistant/chat` tại `backend/src/assistant/`, đăng ký trước `route_layer` xác thực hiện có. Nhận `message` và lịch sử hội thoại giới hạn, chỉ chấp nhận vai trò người dùng và trợ lý từ frontend. Frontend dùng API client có Bearer token hiện tại.
- Dùng phản hồi SSE qua `fetch` POST với các sự kiện `status`, `done`, `error`. `done` mang câu trả lời và bộ lọc hoặc mã phiếu làm căn cứ. Trả `401` khi phiên không hợp lệ và `503` khi chưa cấu hình Gemini. Sau khi mở stream, báo lỗi qua `error`. Truyền thao tác hủy vào request Gemini và vòng lặp để dừng công việc còn lại.
- Đóng gói Gemini sau một interface để kiểm thử bằng client giả lập. Gọi Gemini Interactions API với model `gemini-3.5-flash-lite` và `store=false`. Đọc `GEMINI_API_KEY` ở máy chủ và gửi trong header `x-goog-api-key`. Không đưa khóa vào frontend, SQLite, repo hay log. [Mô hình Gemini](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite) · [Function calling](https://aistudio.google.com/docs/function-calling)
- Mỗi lượt xác thực trước, chọn khai báo tool phù hợp, gọi Gemini, kiểm tra tên và schema của từng lời gọi, chạy truy vấn rồi gửi `function_result` theo đúng `call_id`. Giữ nguyên các bước Gemini đã sinh trong lượt, gồm chữ ký nếu có. Kết thúc khi có câu trả lời, hết ngân sách, người dùng dừng hoặc lỗi không thể phục hồi. Không giữ transaction SQLite trong lúc chờ Gemini.
- Mặc định tối đa 8 lần gọi Gemini hoặc 45 giây cho một tin nhắn. Đặt riêng giới hạn số lần thực thi tool để chặn một phản hồi chứa quá nhiều lời gọi. Giới hạn nội dung tin nhắn, lịch sử và kích thước kết quả trước khi gửi. Nếu cần thu gọn context, cắt các lượt hội thoại cũ đã hoàn thành, giữ nguyên chuỗi gọi tool của lượt hiện tại. Khi hết ngân sách, báo rõ phần đã tra cứu và gợi ý phạm vi hẹp hơn.

## 3. Tool tra cứu SQLite

Danh mục tool có thể mở rộng bằng đăng ký tên, schema và hàm thực thi. Chọn nhóm tool phù hợp với câu hỏi và có đường mở rộng khi chưa đủ thông tin. Giới hạn lượt chạy độc lập với số lượng tool có thể đăng ký.

| Tool | Dữ liệu trả về |
| --- | --- |
| `summarize_income` | Tổng tiền đã thu, tiền hoàn, thu nhập ròng và số giao dịch thành công theo kỳ |
| `breakdown_income` | Tổng hợp theo ngày, tuần, tháng, nguồn thu hoặc phương thức |
| `search_transactions` | Giao dịch theo mã phiếu, kỳ, nguồn thu, phương thức và trạng thái |
| `get_transaction` | Chi tiết một mã phiếu và các khoản hoàn liên quan |
| `search_refunds` | Khoản hoàn theo ngày hoàn, mã phiếu hoặc thuộc tính của giao dịch gốc |

- Dùng truy vấn chỉ đọc do ứng dụng định nghĩa, tham số bind và enum cho nhóm sắp xếp. Giới hạn bảng và trường trả về. Tool không nhận SQL tự do, không tra cứu mã quản trị và không thực hiện thao tác ghi.
- Chuyển khoảng ngày Việt Nam thành khoảng UTC nửa mở. Lọc và tổng hợp trong SQLite trước khi trả JSON. Ưu tiên kết quả tổng hợp cho câu hỏi số liệu. Với danh sách, trả mặc định 20 dòng theo thứ tự ổn định, kèm `next_cursor` khi còn kết quả. Khoanh vùng thời gian hoặc gộp theo tuần/tháng khi số nhóm quá lớn. Câu trả lời phân biệt tổng toàn kỳ với số liệu từ một trang.
- Chỉ gửi trường cần thiết cho Gemini. Dùng dữ liệu và câu hỏi giả lập khi thử bằng Free Tier. Xác nhận cấu hình xử lý dữ liệu trước khi bật truy vấn dữ liệu thật, đặc biệt với tên hội viên, mô tả tự do và số liệu tài chính. [Điều khoản Gemini API](https://aistudio.google.com/docs/terms)

## 4. Thứ tự thực hiện và nghiệm thu

1. Tạo giao diện chat, điều hướng desktop và mobile, trạng thái thiếu khóa. Kiểm tra đăng nhập, mở URL trực tiếp, tải lại và quay về Thu nhập.
2. Viết các tool SQLx và kiểm thử với SQLite tạm. So sánh kết quả với trang Thu nhập cho giao dịch chờ, ranh giới ngày theo giờ Việt Nam và hoàn tiền khác kỳ. Xác minh phân trang không lặp hoặc bỏ dòng, phản hồi có kích thước giới hạn và truy vấn ghi bị từ chối.
3. Nối API và vòng lặp với client Gemini giả lập. Kiểm thử một và nhiều lời gọi tool, tham số sai, tool lạ, hết ngân sách, dừng, lỗi hạn mức và truy cập bằng mã đã thu hồi. Xác minh yêu cầu chưa đăng nhập không gọi Gemini hay tool dữ liệu.
4. Chạy `./scripts/backend.ps1 -Action test` từ thư mục gốc và `npm run build` trong `frontend`. Kiểm thử Playwright ở desktop và 390px với Gemini giả lập. Khi có khóa, chạy thử một câu tổng hợp và một lượt có nhiều lời gọi tool bằng dữ liệu giả lập. Đạt khi số liệu khớp bảng Thu nhập, câu trả lời nêu kỳ và bộ lọc, và trang điều hướng được qua sidebar lẫn di động.
