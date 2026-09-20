# Checklist pilot Phase 2 — Canvas & export (QA gate)

Phạm vi: nghiệm thu luồng pilot **không AI** (AI là Phase 3): tạo canvas →
nhập/sửa → chốt bản → manager đọc → xuất file. Mọi bước chạy trên gói
self-hosted, có thể chặn Internet hoàn toàn. Tham chiếu spec §5.4/§10,
plan Phase 2 task 2.7.

## 1. Điều kiện đầu vào

- Stack chạy qua `compose.yaml` (xem `docs/operations/foundation.md`):
  `docker compose up -d`, migration đã áp dụng, `GET /api/v1/health` = 200.
- Tài khoản pilot: 1 owner, 1 manager, 1 member — tạo qua admin hoặc
  bootstrap. Member sở hữu ít nhất 1 canvas có bản đã chốt.
- **Chặn Internet** ở firewall/proxy trước khi bắt đầu — toàn bộ luồng
  phải hoạt động offline (font đã bundle trong `assets/fonts/`, không CDN).

## 2. Walkthrough pilot (manual)

| # | Bước | Kỳ vọng |
|---|------|---------|
| 1 | Member đăng nhập → `canvas-online/?canvas=<id>` | Form render draft đã lưu; trạng thái "Đã lưu" |
| 2 | Sửa một ô (ví dụ Mục tiêu) | Autosave sau ~2s, nhãn "Đang lưu → Đã lưu"; reload vẫn thấy nội dung |
| 3 | Bấm **Chốt phiên bản** | `v1` xuất hiện trong Lịch sử; draft mới được mở lại từ v1 |
| 4 | Manager đăng nhập → dashboard | Thấy canvas của member trong danh sách; mở được bản đã chốt |
| 5 | Member xuất **JSON / Markdown / Excel / PDF** | File tải về mở được; nội dung = bản đã lưu trên server |
| 6 | Tài khoản ngoài phạm vi subject | Endpoint export trả 404 giống hệt canvas không tồn tại |

## 3. Checklist QA export

### XLSX (formula-injection)

- [ ] Điền ô bắt đầu bằng `=`, `+`, `-`, `@` (ví dụ `=cmd|'/c calc'!A1`,
  `+1+1`, `-2-3`, `@SUM(1)`) → tải Excel → mở trong Excel/LibreOffice:
  ô hiển thị **đúng chuỗi văn bản**, không thực thi công thức, không cảnh
  báo bảo mật. (Đã có test tự động `tests/unit/canvas-export-xlsx.test.ts`;
  bước này xác nhận trên viewer thật.)
- [ ] Ô chứa `<`, `>`, `&`, ký tự XML đặc biệt → file mở không lỗi.

### Markdown (loss warning)

- [ ] Canvas có trường mở rộng (measurement trong `observed[]`) → xuất
  Markdown → UI cảnh báo "Markdown không giữ đủ trường mở rộng — dùng JSON";
  file `.md` chứa đủ 6 mục, phần mở rộng vắng mặt là **có chủ đích**.
- [ ] JSON của cùng version → import lại vào ô "Nhập MD / JSON" → 0 cảnh
  báo, round-trip nguyên vẹn.

### PDF / in (manual, không tự động được)

- [ ] Canvas dài (nhiều KR, nhiều hành động, bảng observed > 10 dòng) →
  In/Lưu PDF → kiểm tra **A4 nhiều trang**: không cắt dòng giữa chừng,
  header bảng lặp lại, không tràn lề.
- [ ] **Dấu tiếng Việt** — kiểm tra kỹ ô chứa `ữ`, `ệ`, `ộ`, `ằ` trong
  PDF đã in: font bundle local phải render đúng, không toong/notdef.
- [ ] Screenshot khung hẹp (~768px) và khung rộng (~1440px): preview export
  không vỡ layout.

### Audit & phân quyền

- [ ] Sau mỗi lần xuất, `GET /api/v1/audit-events` (admin) có event export
  với metadata `{mode, version}` — **không** chứa nội dung canvas.
- [ ] `format=` sai (ví dụ `xml`) → 400; version của canvas khác → 404;
  chưa đăng nhập → 401.
- [ ] Sau khi publish, draft đã bị consume và chưa mở lại → export-preview
  → 404 (không lộ bản nháp cũ).

## 4. Nguyên tắc dữ liệu (nhắc pilot)

- JSON export là **nguồn bảo toàn duy nhất** — Markdown/Excel/PDF là bản
  trình bày, có thể mất trường mở rộng.
- Dashboard chỉ đếm bản **đã chốt**; bản nháp không bao giờ là bằng chứng.
- Series đo lường chỉ lấy từ `observed[].measurement` — không parse số từ
  văn bản tự do.
- Dữ liệu demo seed là giả định đã ẩn danh hóa; trước khi pilot thật, chạy
  `GWP_SEED_DEMO=false` và tạo dữ liệu thật.

## 5. Đã kiểm tự động (bằng chứng)

- `tests/integration/canvas-export.test.ts` — phân quyền 404 đồng nhất,
  JSON round-trip exact, Markdown warnings, audit metadata-only,
  preview draft + 404 sau publish.
- `tests/unit/canvas-export-xlsx.test.ts` — inline-string escaping,
  không formula cell từ chuỗi user.
- `tests/e2e/canvas-export.spec.ts` — toolbar export flush autosave trước,
  history export JSON/Markdown tải đúng, outsider bị 404.
