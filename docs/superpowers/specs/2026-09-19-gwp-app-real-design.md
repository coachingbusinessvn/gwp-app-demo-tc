# Thiết kế: Đưa GWP App từ demo tĩnh thành sản phẩm thật

- **Ngày khởi tạo:** 2026-09-19
- **Cập nhật:** 2026-09-20 · revision 2, sau review tổng thể cả 5 phase
- **Người lập bản đầu:** huy.tran@gwp.vn (cùng Claude)
- **Trạng thái:** Thiết kế đã tối ưu — chờ duyệt bản cập nhật trước khi lập lại plan triển khai
- **Sản phẩm:** Performance Follow-up / Performance Architecture Canvas (GoWise Partners)
- **Hiệu lực:** Bản này thay thế quyết định kỹ thuật của revision 1. Plan Phase 0 ngày
  2026-09-19 không còn hợp lệ để triển khai nguyên trạng.

## 1. Mục tiêu, phạm vi và quyết định cốt lõi

Biến demo HTML/CSS/JS thành ứng dụng tổ chức có tài khoản thật, phân quyền thật,
canvas được lưu và quản lý phiên bản, ba trợ lý AI chạy ngay trong app.

### Ràng buộc

- Khách hàng tự host tại Việt Nam và sở hữu dữ liệu; GoWise không giữ dữ liệu khách.
- **AI chạy local/nội bộ do khách hàng cung cấp**, vẫn dùng **BYOK**: admin cấu hình
  endpoint, API key và model. Không thiết kế luồng AI cloud/fallback ra ngoài.
- Một deployment phục vụ **một company**. Company là thực thể thật nhưng không xây
  sản phẩm multi-tenant trong lần này.
- Một application image dùng cho demo và production; **khác DB, secrets và volume**.
- API-first; web là client đầu tiên. MCP/mobile là dự án sau, không phải deliverable
  của năm phase này.

### Lựa chọn sau review

| Quyết định | Chốt | Lý do / đánh đổi |
|---|---|---|
| Database | **PostgreSQL ngay từ Phase 0**, JSONB cho tài liệu | Không duy trì hai database engine hoặc phải chuyển SQLite → Postgres về sau; chấp nhận một DB service riêng |
| Kiến trúc | Modular monolith Node/TypeScript | Ranh giới module rõ, chưa cần microservices/Redis/message broker |
| Backend | Express + TypeScript; Knex + `pg`; Zod | Tiếp nối hướng plan cũ, một đường triển khai, migrations tường minh |
| Frontend | Giữ HTML/CSS/JS, tách module dùng chung | Tái sử dụng UI; không rewrite SPA; không giữ nguồn dữ liệu hardcode khi chạy thật |
| Canvas | JSON canonical + draft/publish + optimistic concurrency | Không normalize toàn bộ; không ghi đè lịch sử |
| AI | Local endpoint tương thích giao thức chat completions + BYOK | AI chỉ sinh đề xuất; backend kiểm định, người dùng quyết định chốt |
| Vận hành | Docker Compose từ Phase 0 | Các phase sau chạy trên cùng nền triển khai, không dồn packaging đến cuối |

**Mốc giá trị:** cuối Phase 2 có pilot nội bộ không phụ thuộc AI; cuối Phase 4 đủ gói
bàn giao khách hàng. Phase 0–1 demo được nhưng chưa phải sản phẩm nghiệp vụ hoàn chỉnh.

## 2. Kiến trúc tổng thể và ranh giới module

```text
Hạ tầng nội bộ của khách hàng
├─ HTTPS reverse proxy (có sẵn hoặc nằm trong bundle)
├─ App container: Node/TypeScript
│  ├─ Static public assets (allowlist, không phục vụ repository root)
│  ├─ REST /api/v1 + OpenAPI + authenticated streaming
│  ├─ Services: auth · org · authorization · canvas · coaching · AI · settings/audit
│  └─ Repositories + migrations → PostgreSQL
├─ PostgreSQL service + persistent volume (hoặc DB nội bộ đã có)
└─ Local AI service do khách vận hành ← backend AI adapter + BYOK
```

LLM không chạy trong tiến trình Node và không được bao gồm trong app image. Bundle
không cam kết cung cấp GPU/model weights; runbook mô tả kết nối tới dịch vụ AI nội bộ.

### Quy tắc kiến trúc

- Quyền truy cập, chuyển trạng thái, validation chuẩn, tính status/dashboard và lưu
  dữ liệu nằm ở service layer. Mọi service nhận `ActorContext` từ xác thực phía server;
  không nhận actor/role/company do body request tự khai báo.
- Frontend được có presentation logic, form state và validation phục vụ UX; server
  vẫn là nơi quyết định. Parser/schema thuần có thể dùng chung, không cần nhân đôi logic.
- API và wrapper MCP tương lai đều phải đi qua cùng authorization/service boundary.
  Không cho wrapper gọi repository trực tiếp để bỏ qua quyền.
- OpenAPI, `/api/v1`, error envelope `{code, message, details, request_id}` và phân
  trang có từ Phase 0; endpoint nghiệp vụ hoàn thiện theo phase, không hứa API đầy đủ
  ngay Phase 0. Không trả stack trace hoặc secrets trong lỗi.
- Web cùng origin mặc định. CORS chỉ bật theo allowlist khi có web client khác origin;
  không dùng wildcard với credentials. Mobile native không phải lý do bắt buộc mở CORS.
- Collection/list/count/dashboard/export và endpoint theo ID dùng cùng bộ lọc quyền.
  Truy cập tài nguyên không tồn tại hoặc không được đọc đều trả `404` nhất quán.
- Chỉ thư mục public đã build được serve. Source, `.env`, DB dump, prompt nội bộ,
  tài liệu triển khai và fixtures không nằm trong static route.

### Công cụ và module

- Node LTS được hỗ trợ tại thời điểm triển khai; pin phiên bản runtime, dependency
  lockfile và image digest theo release; không dùng tag `latest` cho production.
- PostgreSQL là engine duy nhất trong development, integration test và production.
- Auth: Argon2id cho mật khẩu; JWT access token + phiên refresh lưu ở DB.
- Vitest/Supertest cho service/API; browser E2E cho login, editor, AI và phân quyền UI.
- Module canvas sở hữu schema/parser/validator; module AI không sở hữu quyền ghi canvas.
- Không gọi HTTP tới dịch vụ AI trong transaction DB; publish là transaction ngắn riêng.

## 3. Mô hình dữ liệu và bất biến

Tên dưới đây là hợp đồng khái niệm; migration chọn tên SQL nhất quán. ID mới là UUID;
ID demo cũ được giữ trong mapping import, không buộc production dùng ID như `l1`/`p7`.
Timestamp lưu UTC; ngày nghiệp vụ là `date`, hiển thị theo timezone company (mặc định
`Asia/Ho_Chi_Minh`). Không giữ ngày giả cố định của demo trong tính overdue production.

```text
company          id · name · timezone · created_at
department       id · company_id · name · archived_at?
team             id · company_id · department_id · name · archived_at?
user             id · company_id · email · name · title · password_hash?
                 department_id? · team_id? · manager_id? · status · auth_version
role             id · key (owner|admin|manager|member) · label
user_role        company_id · user_id · role_id

canvas           id · company_id · owner_user_id · name · current_version_id?
                 archived_at? · created_at
canvas_draft     id · company_id · canvas_id · base_version_id? · revision
                 schema_version · body(jsonb) · created_by · updated_by · updated_at
                 source (manual|import|ai) · ai_run_id?
canvas_version   id · company_id · canvas_id · version_no · schema_version
                 body(jsonb) · change_summary · created_by · published_at · ai_run_id?
                 provenance(jsonb)?

setting          company_id · key · value(jsonb) · updated_by · updated_at
deployment_state singleton_id · mode · setup_completed_at? · seed_version?
one_time_token   id · company_id · user_id · purpose · token_hash · expires_at · used_at?
write_receipt    company_id · actor_id · operation · idempotency_key · request_hash
                 resource_id · result_id · created_at · expires_at
auth_session     id · company_id · user_id · token_family_id · expires_at · revoked_at?
refresh_token    id · session_id · token_hash · expires_at · consumed_at? · replaced_by?
audit_event      id · company_id · actor_id? · action · target_type · target_id?
                 outcome · safe_metadata(jsonb) · request_id · created_at
ai_run           id · company_id · actor_id · assistant · canvas_id? · input_version_id?
                 status · model · prompt_version · rubric_version? · config_revision
                 idempotency_key · input_hash · error_code? · usage(jsonb) · timestamps
coaching_session id · company_id · coach_user_id · coachee_user_id · canvas_id?
                 occurred_at · created_by
coaching_report  id · company_id · session_id · ai_run_id? · report_version
                 rubric_version · body(jsonb) · provenance(jsonb) · created_by · created_at
report_share     report_id · company_id · user_id · granted_by · granted_at · revoked_at?
```

### Bất biến bắt buộc

- `company` không có generic create/delete API: first-run tạo đúng một company;
  admin/owner sửa hồ sơ công ty hiện tại. Chặn tạo company thứ hai.
- Unique email đã chuẩn hóa trong company; unique role key; unique user-role;
  unique `(canvas_id, version_no)` và tối đa một draft hoạt động trên mỗi canvas.
- User pending có thể chưa có password; user active bắt buộc có password hash.
  `write_receipt` có unique key theo company/actor/operation/idempotency key, được ghi
  cùng transaction nghiệp vụ và giữ 7 ngày. Retry phải kiểm tra quyền lại trước khi
  trả result ID cũ; key trùng nhưng request hash khác trả `409`.
- Dùng FK/composite FK theo company khi có thể; actor và mọi tài nguyên liên kết phải
  cùng company. `team.department_id` phải khớp `user.department_id` nếu user có team.
- `manager_id` không tự trỏ, không tạo chu trình, không trỏ tài khoản inactive.
  Thay đổi cây được serialize trong transaction theo company để hai thao tác đồng
  thời không vượt qua kiểm tra vòng lặp. Kiểm tra cây ở service, không giả định một
  CHECK constraint đơn hàng có thể kiểm tra toàn cây.
- Department/team đang được tham chiếu chỉ archive hoặc chuyển thành viên trước;
  không cascade xóa users/canvas. User được deactivate, không hard-delete làm mất tác giả.
  Deactivate manager có cấp dưới phải do owner chuyển tuyến hoặc đưa cấp dưới về chưa
  gán manager trong cùng transaction; admin không được gián tiếp sửa cây bằng deactivate.
- Canvas có một chủ là user; một user có thể có nhiều canvas. Chuyển chủ chỉ owner
  được làm, phải xác nhận tác động quyền và audit; không đổi tác giả version lịch sử.
- `current_version_id` và `base_version_id` phải thuộc đúng canvas/company. Các reference
  trong JSON (assignee/behavior/output) được service kiểm tra trước khi lưu.
- Index theo truy vấn: user/company/manager, canvas/company/owner, version/canvas/time,
  session/user, audit/company/time. JSONB index chỉ thêm khi truy vấn đã cần.
- Cấu hình chỉ có một nguồn `setting`; không nhân đôi `company.settings`. Secret dùng
  ciphertext có key version; không trả ciphertext hoặc plaintext qua API đọc settings.

## 4. Tổ chức, vai trò và quyền riêng tư

Company → Department → Team là cơ cấu hành chính. `manager_id` là tuyến báo cáo độc lập;
có thể quản lý khác department trong cùng company. `title` chỉ để hiển thị, không cấp quyền.
Vai trò cộng dồn; tài khoản mới có `member` mặc định.

| Hành động | owner | admin thuần | manager | member |
|---|---|---|---|---|
| Xem/sửa canvas của mình | Có | Có, theo sở hữu | Có | Có |
| Xem/sửa/publish canvas của người khác | Tất cả | Không | Subtree hiện tại | Không |
| Cấu hình org, branding, tài khoản thông thường | Có | Có, trong giới hạn dưới đây | Không | Không |
| Cấp/thu hồi vai trò, đổi `manager_id`, chuyển chủ canvas | Có | Không | Không | Không |
| Cấu hình AI/BYOK | Có | Có, endpoint trong allowlist triển khai | Không | Không |
| Chạy AI trên canvas | Theo quyền sửa | Theo quyền sở hữu | Theo quyền sửa | Theo quyền sở hữu |
| Đọc coaching report | Tất cả, có audit | Chỉ nếu được cấp riêng | Không mặc nhiên theo subtree | Không mặc nhiên theo sở hữu canvas |
| Xem audit quản trị | Có | Metadata vận hành, không nội dung coaching | Không | Không |

**Ranh giới chống tự nâng quyền:** chỉ owner sửa vai trò/tuyến báo cáo, kể cả khi tạo user
(admin tạo member chưa gán manager; owner gán sau). Admin không chỉnh/deactivate tài khoản
đặc quyền owner/admin, không đổi thông tin đăng nhập hay đặt mật khẩu mới cho người khác.
Bootstrap/recovery tài khoản theo §8. Không triển khai workflow phê duyệt nhiều bước ở v1;
owner thực hiện trực tiếp thao tác đặc quyền và hệ thống audit.

- Không xóa/hạ quyền/deactivate owner hoạt động cuối cùng; serialize thao tác này.
- Manager chỉ có quyền subtree khi thực sự giữ role manager; là cấp trên trong cây
  nhưng không có role đó không tự được mở quyền đọc.
- Quyền canvas áp dụng cho cả draft và lịch sử. Khi đổi tuyến báo cáo: quản lý cũ mất
  quyền, quản lý mới được xem lịch sử canvas của subtree mới. Không tự chuyển quyền report.
- Kiểm tra quyền từ trạng thái DB hiện tại trên mỗi request và trước commit AI/publish;
  không tin role/subtree cũ trong JWT. Không thể thu hồi nội dung đã tải xuống trước đó.
- Người được gán action không tự được quyền đọc toàn canvas; chỉ xuất hiện trong
  dashboard nếu họ cũng có quyền đọc canvas. Không mở quyền bằng chuỗi tên/chức danh.
- Quyền riêng tư này thuộc tầng ứng dụng. Owner và người quản trị OS/DB là trusted
  operators; không tuyên bố ngăn họ đọc dữ liệu bằng cơ chế RBAC của app.

## 5. Hợp đồng canvas, nhập/xuất và dashboard

### 5.1 Một schema canonical

Lấy mô hình field đầy đủ của Canvas Online làm cơ sở: `meta`, `goal.statement/context`,
`kr.current/target/deadline`, outputs, behaviors, boxes, actions, risks, plan, observed,
reviews. Không lưu thẳng cấu trúc viết tắt của demo như `kr.cur`/`actions.own`.

- Giữ thuật ngữ nghiệp vụ **Canvas schema 3.0**; dùng `schema_version` của payload lưu trữ
  độc lập (khởi đầu `1`) để theo dõi thay đổi kỹ thuật. Không đồng nhất với `version_no`.
- Phase 2 phải giao JSON Schema/validator, enum chuẩn, fixtures hợp lệ/không hợp lệ và
  adapter `legacy demo → canonical`, `Markdown ↔ canonical`, `editor ↔ canonical`.
- Row có ID ổn định; liên kết behavior/output bằng ID, không bằng so khớp tên. Import
  Markdown ánh xạ tên duy nhất sang ID; mơ hồ thì yêu cầu xác nhận, không đoán.
- Action/box có `assignee_user_id?` và `assignee_label`. Chức danh cũ giữ làm label;
  không gán người bằng substring. ID từ file import phải được xác nhận trong company đích.
- Owner/quyền/tác giả/company/version ID do server quản lý, không lấy từ Markdown/JSON
  nhập vào. Import chỉ nhận allowlist field nội dung và có báo cáo lỗi theo đường dẫn.
- Không bỏ field lạ hoặc nội dung không parse được một cách im lặng; báo lỗi/cảnh báo
  để người dùng xử lý. Payload sai kiểu/schema vượt giới hạn bị từ chối phía server.
- Adapter demo không dựng lịch sử giả: các version cũ chỉ có `brief` phải được đánh dấu
  thiếu snapshot, không copy nội dung mới nhất xuống lịch sử. Chỉ import snapshot đầy đủ
  thành version; phần brief giữ trong ghi chú migration của dữ liệu demo.

### 5.2 Vòng đời và đồng thời

```text
Canvas mới hoặc version đã publish
  → tạo draft (ghi base_version_id, revision=1)
  → lưu draft với expected_revision → tăng revision
  → validate + người dùng xem diff + xác nhận publish
  → transaction tạo snapshot version bất biến + cập nhật current_version_id + bỏ draft
```

- Có một draft dùng chung trên canvas; không realtime collaboration/branch/merge tự động.
- Draft là trạng thái lưu trữ riêng, **không phải** `meta.stage=DRAFT`. Canvas đã publish
  vẫn có thể ở stage nghiệp vụ DRAFT/PILOTING/VALIDATED.
- Mỗi ghi draft/publish kèm revision mong đợi; mismatch hoặc base không còn hiện hành
  trả `409`, giữ bản sửa trong UI để người dùng so sánh/tải lại, không last-write-wins.
- Publish khóa canvas và kiểm tra quyền, revision/base, nội dung trong một transaction;
  unique version number là lớp bảo vệ bổ sung. Retry cùng idempotency key không tạo bản đôi.
- Published snapshot bất biến. Restore version cũ tạo draft mới dựa trên version hiện hành;
  không sửa/xóa snapshot. Archive canvas không xóa lịch sử.
- AI không publish, không overwrite draft đang tồn tại. Người dùng có thể xem đề xuất
  và áp dụng bằng thao tác ghi draft có revision; thay đổi không liên quan phải được giữ.
  Lần chạy AI ghi nhận base version và draft revision lúc bắt đầu; nếu draft thay đổi
  trước khi áp dụng thì trả conflict, không tự lấy revision mới để vượt kiểm tra.
- UI hiển thị rõ Đang lưu/Đã lưu/Lỗi/Xung đột, cảnh báo rời trang khi chưa lưu; không lưu
  nội dung coaching nhạy cảm vào localStorage mặc định. Chưa hỗ trợ offline editing.

### 5.3 Dashboard và export

- Dashboard/status/overdue/subtree/blockers chỉ dùng **latest published**, theo quyền;
  canvas chỉ có draft hiển thị “chưa chốt”, không thành bằng chứng hiệu suất.
- Chuỗi biểu đồ không là `canvas.series` sửa độc lập. Derived từ observed/measurement
  trong snapshot có ID, layer, ngày, giá trị số, unit và baseline/target tương ứng.
  Deduplicate theo ID quan sát; thay định nghĩa metric tách series, không nối sai đơn vị.
- Không tự parse số từ câu văn như “2,1 tỷ”; dữ liệu chưa có số chuẩn thì hiển thị bảng
  hoặc trạng thái chưa đủ dữ liệu. Đề xuất AI không tự biến thành observed evidence.
- JSON hỗ trợ round-trip đầy đủ nội dung canonical. Markdown bảo toàn các field thuộc
  khung nghiệp vụ schema 3.0, không bảo toàn UUID/quyền hoặc extension đo lường có cấu trúc;
  export phải cảnh báo khi có extension chỉ JSON mới giữ đầy đủ, không mất dữ liệu âm thầm.
- Excel phục vụ trình bày; PDF dùng bản in trình duyệt; PNG dùng renderer hiện có.
  Không hứa round-trip hoặc pixel-identical qua Excel/PDF/PNG. QA tiếng Việt, bảng dài,
  ngắt trang và giá trị có thể bị hiểu là công thức khi export spreadsheet.

## 6. Coaching session và quyền report

Report đánh giá **coach**, không mặc nhiên thuộc người sở hữu canvas. Session ghi rõ
coach/coachee, có thể liên kết canvas nhưng chỉ khi actor có quyền đọc canvas đó.

- Người tạo session phải là coach đăng nhập, đồng thời là manager của coachee hoặc owner.
  Không nhận coach ID tùy ý để mạo danh người thực hiện. Owner có thể nhập phiên lịch sử
  thay người khác, bắt buộc audit hành động này.
- Report mặc định chỉ creator, coach và owner đọc được. Coach/owner có thể chia sẻ rõ
  ràng cho user cùng company bằng `report_share`; creator nhập hộ không tự có quyền share.
- Coachee, cấp trên mới hoặc người đọc canvas không tự có quyền report. Thu hồi share
  có hiệu lực từ request tiếp theo; quyền canvas/report luôn kiểm tra độc lập.
  *Cập nhật 2026-10-06:* coachee **xem được danh sách phiên về mình** (metadata: coach,
  thời điểm, canvas liên kết chỉ khi là canvas của họ) — chỉ xem, không ghi/chấm; report
  vẫn theo quy tắc trên (chỉ đọc khi được share).
- Khi dùng report làm input Renderer, actor cần cả quyền đọc report và sửa canvas đích;
  không tự chia sẻ toàn bộ report, transcript hay điểm coach vào canvas.
- Transcript chỉ tồn tại trong bộ nhớ cho lần xử lý; **không lưu raw transcript** trong
  DB, log, audit hoặc localStorage. Retry sau restart yêu cầu người dùng cung cấp lại.
  Runbook yêu cầu tắt request-body logging ở reverse proxy và local AI gateway/model server;
  chính sách không lưu transcript cần được kiểm tra cả chuỗi dịch vụ, không chỉ Node app.
- Report đã chấp nhận giữ cho tới khi coach/owner xóa có xác nhận; không cascade khi user
  deactivate. Output có thể chứa trích dẫn nhạy cảm, phải hiển thị preview trước lưu/share.
  Xóa report gồm body và shares; audit giữ ID/sự kiện, không giữ nội dung đã xóa.
- Report immutable theo phiên bản; chấm lại tạo report version mới, không đổi kết quả cũ.
  Rubric version và model/prompt metadata phải truy xuất được; không coi điểm AI là quyết
  định nhân sự tự động.
  Khi lưu report/version có AI, copy provenance tối thiểu (model/prompt/rubric/config
  revision, thời điểm) vào metadata bất biến; FK `ai_run_id` nullable với ON DELETE SET NULL
  để cleanup AI metadata không xóa hoặc làm mất provenance của nội dung đã lưu.

## 7. AI local + BYOK

### 7.1 Cấu hình và giao thức

- Company có một cấu hình active: enabled, base URL nội bộ, API key mã hóa, model,
  timeout, giới hạn input/output và concurrency. App không quản lý vòng đời model/GPU.
- BYOK là credential của AI gateway nội bộ, không yêu cầu tài khoản nhà cung cấp cloud.
  Endpoint local chưa có auth cần gateway có API key trước khi tích hợp.
- Admin nhập key qua HTTPS một lần; backend không trả key lại. UI chỉ nhận `configured`
  và thao tác thay/xóa key. Không tuyên bố key chưa bao giờ đi qua trình duyệt admin.
- Allowed host/port do operator cấu hình ngoài UI; cho phép IP private nội bộ có chủ ý,
  chặn redirect sang đích khác và URL chứa credentials. Admin không dùng base URL tùy ý
  để gọi dịch vụ hệ thống khác. TLS xác thực bình thường; HTTP chỉ cho mạng tin cậy khi
  operator bật rõ ràng, không tự tắt certificate verification.
- Adapter hỗ trợ tập giao thức đã kiểm thử, không suy ra mọi endpoint “compatible” đều
  tương đương. Nút test dùng prompt tổng hợp không có dữ liệu khách, kiểm tra auth/model,
  context limit, text completion và streaming. Cho phép non-stream nếu model không stream.
- Chưa cấu hình/AI tắt: UI báo rõ; mọi chức năng canvas vẫn dùng được.

### 7.2 Ba trợ lý

| Trợ lý | Input | Output và nơi lưu |
|---|---|---|
| Canvas Session Renderer (Phase 3) | Snapshot canvas + ghi chú, hoặc report được phép đọc | Markdown canonical → parser/validator server → preview/diff → người dùng áp dụng draft |
| Canvas Coach (Phase 3) | Snapshot canvas | Rubric v3.0 /100 + đề xuất ORACLE; preview, không tự sửa canvas; v1 không lưu lịch sử hội thoại |
| ORACLE Coaching Grader (Phase 4) | Transcript phiên coaching + session metadata | Report ORACLE-v3 có cấu trúc, preview rồi xác nhận lưu |

System prompt/template có version ở server, tách output contract khỏi nội dung phương pháp.
Không port yêu cầu provider code execution để sinh Excel/HTML; app tự export. Không thêm
tool thực thi shell/SQL hoặc quyền tự gọi API nghiệp vụ cho model.

### 7.3 Hợp đồng an toàn, lỗi và tài nguyên

- Consent trước mỗi lần gửi nội dung cho cả ba trợ lý; ghi actor/time/input reference
  và prompt/model version, không ghi raw prompt/transcript vào audit.
- Canvas/transcript là dữ liệu không tin cậy. Prompt separation chỉ là một lớp; output
  vẫn phải qua schema/enum/reference validation và escape/sanitize khi render.
- Phân biệt Fact/Interpretation/Assumption/Hypothesis/Recommendation. Không tự nâng stage,
  bịa observed evidence hay biến inference thành dữ kiện. Human review là bắt buộc;
  schema validation không chứng minh nội dung đúng.
- Renderer có lỗi parse/validation: chỉ preview lỗi, không ghi draft. Cảnh báo ngữ nghĩa
  phải được xử lý/xác nhận rõ; không coi “0 cảnh báo import” là chứng nhận chất lượng.
- Rubric output kiểm tra giới hạn từng điểm, tổng điểm và evidence references. Bộ mẫu
  tiếng Việt kiểm thử thiếu dữ kiện, mâu thuẫn, prompt injection, output bị cắt, tên trùng.
- Mặc định pilot: tối đa 1 MiB request nội dung AI, output tối đa 8.192 token, timeout
  tổng 180 giây, 2 request AI đồng thời/company, không hàng đợi vô hạn. Context budget
  phải phù hợp model được cấu hình; vượt giới hạn trả lỗi trước gọi, không cắt ngầm.
- `ai_run` lưu metadata/status, không lưu raw input/output. SSE qua authenticated fetch;
  request start có idempotency key và hash nội dung trong phạm vi actor/company/assistant.
  Cùng key khác nội dung trả `409`; cùng request đang chạy không tạo lần gọi thứ hai.
- Trạng thái queued/running/succeeded/failed/cancelled/interrupted. Kết quả preview giữ
  trong bộ nhớ có TTL 15 phút; hết TTL/restart thì báo cần chạy lại, không giả vờ có thể resume.
  AI run đang chạy khi restart thành interrupted; không tự retry transcript không còn.
- Disconnect/hủy chủ động phải dừng upstream nếu có thể; lỗi timeout/429/unavailable
  hiển thị trạng thái có thể thử lại, không ghi kết quả dở hoặc auto-retry không giới hạn.
- Trước áp dụng draft/lưu report kiểm tra lại quyền và revision; quyền bị thu hồi trong
  lúc AI chạy thì từ chối lưu. Usage metadata lưu khi endpoint cung cấp, không bịa token count.

## 8. Xác thực, first-run và demo

- Access JWT thời hạn ngắn (mặc định 10 phút), có issuer/audience/session ID; server kiểm
  tra session chưa bị revoke và user active mỗi request. Refresh session tối đa 7 ngày.
- Web giữ access token trong memory, refresh token trong cookie HttpOnly/Secure/SameSite;
  refresh/logout kiểm tra Origin và chống CSRF. Không lưu bearer/refresh trong localStorage.
  Mobile token delivery là contract riêng trong dự án mobile, không cần xây trước.
- Refresh rotation nguyên tử, token hash trong DB; giữ dấu consumed để phát hiện reuse
  và revoke token family. Client phối hợp single-flight refresh cả giữa các tab, không
  chỉ trong một trang; test refresh đồng thời và reuse độc lập.
- Logout revoke session; đổi mật khẩu, deactivate hoặc recovery revoke mọi session user.
  Đổi role/cây báo cáo có hiệu lực ngay qua kiểm tra quyền hiện hành, không chờ JWT hết hạn.
- Rate limit login/setup/refresh theo account và IP, lỗi đăng nhập không tiết lộ user có
  tồn tại; mật khẩu/key không vào log. Argon2id cost được đo trên cấu hình máy pilot.
- First-run yêu cầu bootstrap token từ secret của operator, chỉ hoạt động khi chưa có
  company/owner. Tạo company+owner trong một transaction khóa setup; request đua không tạo
  owner thứ hai. Sau thành công khóa setup vĩnh viễn, không mở lại vì thiếu bảng bất thường.
- Production tạo member bằng mã kích hoạt một lần, hết hạn 24 giờ, hash trong DB;
  chỉ owner được phát hành mã có khả năng chiếm tài khoản. Admin được tạo hồ sơ pending,
  không được đặt password hoặc đọc mã kích hoạt. Không cần SMTP ngoài mạng.
- User tự đổi mật khẩu khi biết mật khẩu cũ. Quên mật khẩu: owner phát mã reset một lần,
  audit và revoke sessions; mất owner dùng CLI recovery trên máy chủ, không public endpoint.
- `DEMO_MODE` là cấu hình triển khai bất biến của DB, không phải setting sửa trên UI.
  Mỗi DB ghi deployment mode; app từ chối khởi động nếu mode không khớp. Demo seed có
  version/idempotent, reset chỉ bằng lệnh operator với xác nhận DB demo, không xóa production.
- Demo dùng cùng auth/authorization, có tài khoản mẫu được công bố; không bypass quyền.
  Production không có tài khoản mặc định, không seed tên người/canvas demo vào DB thật.
- Fonts/scripts/assets cần cho runtime được bundle nội bộ; không phụ thuộc CDN, telemetry
  hoặc mạng Internet cho login/canvas/report. AI cũng chỉ kết nối dịch vụ local đã cấu hình.

## 9. Vận hành, audit và dữ liệu

### Đóng gói và cấu hình

- Từ Phase 0: app image + Compose app/Postgres, persistent DB volume, health/readiness,
  migrations có version; reverse proxy HTTPS có thể dùng hạ tầng khách đã có.
- Database không publish port ra Internet; app chạy non-root, DB account ứng dụng chỉ
  có quyền cần thiết. Migration dùng credential riêng với quyền DDL.
- Secrets qua file mount/secret store nội bộ hoặc env được bảo vệ: `DATABASE_URL`,
  `JWT_SECRET`, `APP_KEY`, `BOOTSTRAP_TOKEN`. Cấu hình khác: `DEMO_MODE`, `APP_ORIGIN`,
  `AI_ALLOWED_HOSTS`; không commit `.env` thật. Ciphertext có key version và runbook xoay khóa.
- Liveness không phụ thuộc LLM; readiness kiểm tra DB/migration. AI lỗi không làm mất
  chức năng canvas. Graceful shutdown dừng nhận việc mới và đánh dấu AI bị ngắt.

### Audit và retention

- Audit tối thiểu có từ Phase 0: login/logout/recovery, thay quyền/org, deactivate,
  đổi config/key (không giá trị secret), publish/restore/archive, AI consent/run,
  đọc/share/xóa coaching report và export dữ liệu; bổ sung event khi module tương ứng ship.
- Audit append-only với DB account ứng dụng; không có API sửa/xóa audit. Cleanup retention
  chạy bằng job quyền riêng. Không hứa chống sửa bởi OS/DB administrator.
- Mặc định retention: audit 365 ngày, AI metadata 90 ngày, operational logs 30 ngày;
  owner được tăng thời gian giữ. Không log body, raw transcript, Authorization hoặc key.
- Published canvas giữ trong pilot; archive thay hard-delete. Report xóa theo §6.
  Backup có thể còn dữ liệu đã xóa tới hết retention, phải nêu rõ trong runbook.

### Backup, restore và upgrade

- Backup tự động hằng ngày bằng `pg_dump` custom format; giữ 30 bản ngày trong kho nội bộ
  khác failure domain với volume DB, mã hóa và hạn chế quyền. Không copy live data directory.
- Backup bao gồm DB, release/migration metadata, cấu hình phục hồi và quy trình cấp lại
  DB roles; secrets/`APP_KEY` được sao lưu mã hóa riêng. Thiếu APP_KEY thì BYOK ciphertext
  không khôi phục được. DB dump không thay cho backup secrets hoặc cluster roles.
- Restore drill trên máy/DB sạch: phục hồi roles/schema/data, đăng nhập, kiểm tra quyền,
  mở version lịch sử, giải mã/test AI bằng prompt tổng hợp và publish thử canvas riêng.
- Mục tiêu pilot: **RPO ≤24 giờ, RTO ≤4 giờ**, phải đo trong restore drill; chưa là SLA.
- Upgrade: backup đã kiểm tra, maintenance window, chạy migration một lần có lock,
  deploy app, smoke test. Rollback app chỉ khi schema tương thích; nếu migration phá
  tương thích thì restore backup và công bố khoảng dữ liệu mất, không downgrade mù.
- Runbook tiếng Việt gồm install offline (image bundle), HTTPS, local AI, backup/restore,
  recovery owner, xoay secrets, upgrade/rollback và xử lý đầy đĩa/DB unavailable.

Tham chiếu kỹ thuật: [PostgreSQL SQL dump](https://www.postgresql.org/docs/current/backup-dump.html)
và [constraints](https://www.postgresql.org/docs/current/ddl-constraints.html).

## 10. Năm phase và điều kiện nghiệm thu

Một spec tổng, **một implementation plan riêng cho mỗi phase**; không viết một plan khổng
lồ cho tất cả. Chỉ bắt đầu phase kế khi các điều kiện của phase trước đã có bằng chứng test.

| Phase | Deliverable | Điều kiện nghiệm thu bắt buộc |
|---|---|---|
| **0 · Nền tảng** | Express/TS, PostgreSQL/migrations, OpenAPI/auth, bootstrap owner, audit cơ bản, Compose, public assets sạch; demo seed identity tách biệt | Setup đua chỉ tạo một owner; login/refresh/reuse/logout/deactivate đúng; restart giữ DB; static không lộ source/secrets; không còn production login giả; backup/restore smoke test |
| **1 · Org & quyền** | Org CRUD/archive, user lifecycle/activation/recovery, role và cây báo cáo do owner quản lý; policy service dùng chung | Role matrix có test allow/deny; admin không tự nâng quyền/chiếm tài khoản; last owner được bảo vệ; không tạo cycle kể cả ghi đồng thời; manager cũ mất quyền; ID khác company bị từ chối |
| **2 · Canvas & pilot** | Schema/adapters, demo canvas migration, editor draft/publish, version history/diff/restore, dashboard thật, import/export | Không mất dữ liệu qua JSON/Markdown theo contract; lỗi import không mất draft; sửa đồng thời trả 409; publish retry không trùng; lịch sử bất biến; dashboard chỉ published; truy cập list/detail/export đều có permission test |
| **3 · AI local BYOK** | Settings/test connection, adapter, AI run/streaming, Renderer + Coach, preview/diff/consent | AI off app vẫn chạy; key không bị trả/log; output sai/timeout không ghi canvas; hủy/retry có giới hạn; quyền bị thu hồi giữa chừng chặn save; bộ mẫu Việt + rubric được người phụ trách nghiệp vụ duyệt trên model local mục tiêu |
| **4 · Coaching Report & bàn giao** | Session/grader/report ACL/share/delete, retention jobs, runbook, offline bundle, diễn tập upgrade/restore và QA toàn luồng | Không suy ra quyền report từ canvas; raw transcript không lưu; shared report revoke đúng; chạy được khi cắt Internet; restore đạt mục tiêu pilot; kiểm thử nâng từ release trước và handover trên máy sạch |

### Kiểm thử xuyên phase và quy mô pilot

- Integration test dùng PostgreSQL thật, không thay bằng SQLite hoặc mock toàn repository.
- Test riêng anonymous/member/manager/admin/owner, direct ID access, list/count/export,
  role change, archived/inactive, cyclic org và stale revision.
- E2E tối thiểu: owner setup → tạo org/member → kích hoạt → tạo/sửa/publish canvas →
  manager review → Renderer tạo đề xuất → publish → grader/report share đúng đối tượng.
- Baseline benchmark đề xuất: 500 user, 5.000 canvas, 100.000 version, 50 phiên web
  đồng thời trên máy app+DB 4 vCPU/8 GiB (LLM riêng). API thông thường p95 ≤500 ms trên
  LAN, không tính AI/export lớn; ghi lại workload, kích thước payload và kết quả thực đo.
- Request JSON/import thường giới hạn 2 MiB; pagination mặc định 25, tối đa 100.
  Tải vượt ngưỡng phải được từ chối rõ ràng, không làm hết bộ nhớ tiến trình.
- Demo history/series là fixture minh họa, không chứng nhận tính đúng của dữ liệu khách.
  Mỗi phase phải phân biệt test tự động, QA thủ công và giới hạn chưa kiểm chứng.

## 11. Nguồn tái sử dụng và quy tắc port

Trong repository hiện tại:

- `assets/data.js`: fixture demo, không nguồn dữ liệu runtime production.
- `assets/app.js`: tham khảo dashboard/status; chuyển business logic sang service,
  thay matching chức danh bằng ID và ngày giả bằng clock/timezone thật.
- `canvas-online/index.html`: form/parser/export, tách module trước khi tích hợp API;
  kiểm thử cấu trúc đầy đủ thay vì coi schema demo và editor là một.
- `assets/export.js`, `coaching-report/index.html`: tái sử dụng trình bày có chọn lọc,
  không kế thừa giả định auth/storage của demo.

Từ `/Volumes/SS/projects/gwp-canvas-performance-architecture`:

- `canvas-session-renderer/01_project_instruction.md`: Renderer và output contract.
- `canvas-coach-bot/04_master_instruction.md`, `05_prompt_stack.md`,
  `knowledge_canvas_coach.md`: rubric v3.0, phương pháp và consent/safety.
- `Performance_Architecture_Canvas_GoWise.xlsx`: layout chuẩn để QA export, không runtime dependency.

Từ `/Volumes/SS/projects/gwp_chatbot_oracle`:

- `oracle-coaching-model.md`: ORACLE-v3.
- `sample-transcript.txt`, `scripts/validate_oracle_output.py`: fixture và kiểm định.

Khi port: ghi source revision/checksum và kiểm tra quyền sử dụng; đưa tài nguyên cần thiết
vào repository/package có version. Không để build/runtime phụ thuộc absolute path máy tác giả.

## 12. Ngoài phạm vi và bước tiếp theo

- Multi-company UI/tenant isolation như SaaS; SSO/LDAP; MCP server/mobile client thực tế.
- SQLite/dual-database compatibility; microservices; HA/PITR; managed cloud services.
- Realtime co-edit, offline sync, branching/merge tự động, vector DB/RAG và agent tự hành.
- Lưu raw transcript, ghi âm/STT, lịch sử chat AI dài hạn hoặc quyết định nhân sự tự động.
- Audit nâng cao/SIEM; không loại bỏ audit tối thiểu đã quy định ở §9.

**Bước tiếp theo sau khi duyệt revision 2:** viết lại plan Phase 0 theo PostgreSQL-only,
auth/bootstrap an toàn, static allowlist và Compose ngay từ đầu. Plan cũ chỉ giữ để tham khảo;
không lấy các code block cũ về SQLite, localStorage token hoặc serve repo root để triển khai.
