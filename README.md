# App demo TC — Performance Follow-up

Bản demo giao diện (HTML/CSS/JS tĩnh, không backend, không thư viện ngoài) cho luồng **Leader theo dõi hiệu suất đội ngũ bằng Performance Architecture Canvas**, có trợ lý AI đi kèm là hai chatbot đã triển khai của dự án.

Mở bằng dev server có sẵn: `python3 -m http.server 8765 --directory docs` rồi vào `http://localhost:8765/app-demo-tc/`. Chạy được cả bằng `file://`.

## Luồng màn hình

```
index.html         Đăng nhập (chọn vai trò, không mật khẩu thật)
      ↓
dashboard.html     Cần bạn xử lý · Đội ngũ của tôi (cây 3 tầng) · Canvas cá nhân
      ↓ bấm một người
employee.html      Biểu đồ 3 tầng bằng chứng + danh sách canvas theo tuần
      ↓ bấm một bản
canvas.html        Canvas chi tiết · Gợi ý cho phiên 1-1 · Xuất Excel / Markdown
```

Mọi màn hình đều có lối sang **Tạo canvas mới** và **Nhập canvas từ Markdown** (mở `../canvas-online/`, riêng link `#import` mở sẵn ô nhập).

## Chỉ số hiệu suất được vẽ là gì

Biểu đồ chính là **ba tầng bằng chứng của schema 3.0 — BEHAVIOR → OUTPUT → RESULT** — mỗi tầng chuẩn hóa về *% tiến độ từ mức nền tới mục tiêu* để so được trên cùng một trục.

Chọn ba đường này thay vì một chỉ số đơn vì chúng chính là chuỗi nhân quả của canvas, và khoảng cách giữa chúng đọc được **độ trễ**: hành vi đổi trước, đầu ra đổi sau vài tuần, kết quả đến cuối cùng. Nhờ đó Leader trả lời được câu khó nhất khi coach: *chưa thấy kết quả thì nên kiên nhẫn hay đổi hướng?* Nếu hành vi đã lên mà đầu ra đứng im quá lâu, giả thuyết sai — ADJUST. Nếu hành vi chưa lên, vấn đề nằm ở điều kiện (6 Boxes), chưa phải ở nỗ lực.

Ví dụ rõ nhất trong demo: canvas Thu hồi nợ sớm (`employee.html?p=thn`).

## Thiết kế cho quản lý cấp cao

Dashboard mở đầu bằng khối **Cần bạn xử lý**, không phải danh sách phẳng:

- **Nút thắt bạn giữ** — các điều kiện 6 Boxes mức Cao mà *người sở hữu chính là người đang đăng nhập*. Đây là loại nút thắt nằm im lâu nhất vì cấp dưới không tự gỡ được; canvas Thu hồi nợ trong demo có hai ô như vậy suốt 4 tuần.
- **Người cần bạn ghé qua trước** — ai quá hạn, ai đứt nhịp cập nhật, ai còn chờ bằng chứng thực tế.
- **Đang có tiến triển — nên ghi nhận** — để buổi 1-1 không chỉ đi chữa cháy.

Cây tổ chức có chấm màu trạng thái ngay trên từng người, nên Leader thấy vùng trắng (người chưa có canvas) mà không phải mở từng nhánh.

## Nối với trợ lý AI

Mỗi bản canvas có **Sao chép Markdown** và **Tải Excel** ngay tại chỗ — cùng khung schema 3.0 mà Canvas Online xuất ra, nên dán được thẳng vào:

| Trợ lý | Dùng khi |
|---|---|
| **Canvas Session Renderer** (Claude Project) | Sau mỗi phiên 1-1: dán canvas + ghi chú phiên → phân tích, dựng bản mới, so sánh v1→v2, xuất Excel/HTML |
| **Canvas Coach** (Custom GPT / Claude Project) | Cần chấm điểm rubric v3.0 và coach cải tiến theo ORACLE |
| **Canvas Online** | Muốn sửa tay trên biểu mẫu rồi xuất lại |

Đã kiểm: cả 9 bản Markdown mà app sinh ra đều nhập vào Canvas Online với **0 cảnh báo**.

## Dữ liệu

Toàn bộ là **giả định, đã ẩn danh hóa** — tên người và số liệu đều không có thật. Nội dung canvas lấy từ bộ mẫu đã duyệt trong `canvas-session-renderer/samples/` (PGD Quận 7, Thu hồi nợ sớm, Thẩm định, Tuyển dụng), cộng một canvas cấp vùng soạn riêng cho vai Giám đốc vùng.

Sửa dữ liệu tại `assets/data.js`; phiên đăng nhập lưu trong `localStorage` của trình duyệt.

## Giới hạn của bản demo

Không có backend, không xác thực thật (mật khẩu chỉ là hình thức), không lưu chỉnh sửa canvas — đây là bản trình diễn luồng và giao diện, chưa phải sản phẩm.
