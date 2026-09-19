# Thiết kế: Đưa GWP App từ demo tĩnh thành sản phẩm thật

- **Ngày:** 2026-09-19
- **Người lập:** huy.tran@gwp.vn (cùng Claude)
- **Trạng thái:** Design — chờ duyệt trước khi lập kế hoạch triển khai
- **Sản phẩm:** Performance Follow-up / Performance Architecture Canvas (GoWise Partners)

## 1. Mục tiêu & bối cảnh

Biến bản demo tĩnh hiện tại (HTML/CSS/JS thuần trên GitHub Pages, không backend,
dữ liệu hardcode trong `assets/data.js`, đăng nhập giả bằng chọn vai trò, canvas không
lưu được, trợ lý AI là các công cụ ngoài — Claude Project / Custom GPT) thành **một sản
phẩm thật** với ba yêu cầu chính do người dùng đặt ra:

1. **Làm cho app "thật"** — mọi tính năng chạy *bên trong* app, không phải nhảy ra công cụ ngoài.
2. **AI dùng BYOK** (bring-your-own-key), cấu hình trong khu vực admin.
3. **Dùng cho tổ chức** — quản lý được **Company → Department → Team → Staff** và **vai trò/phân quyền**.

### Ràng buộc nền tảng (bất biến)

- **Tự host trên hạ tầng của khách hàng; khách hàng sở hữu dữ liệu.** GoWise Partners
  không giữ dữ liệu khách hàng.
- **Dữ liệu và hosting nằm trong Việt Nam.** Phần lớn khách hàng chạy trên máy chủ
  nội bộ (on-prem) hoặc thuê máy chủ từ nhà cung cấp VN đáng tin cậy (Viettel / FPT).
  **Không** dùng dịch vụ managed đặt ngoài VN (Supabase, Firebase, Vercel, cloud US/EU) để
  lưu dữ liệu khách hàng.
- **Chạy được ở hai chế độ từ cùng một bản build:** demo cho tổ chức (seed dữ liệu mẫu)
  và triển khai thật cho khách hàng (dữ liệu của họ).
- **Kiến trúc API-first, sẵn sàng cho API đầy đủ, MCP server và mobile app** ở bước sau
  (xem §3, §8).

### Thành công là gì

- Một người thật đăng nhập bằng tài khoản thật, tạo/sửa canvas, dữ liệu được lưu và chia
  sẻ theo đúng phân quyền.
- Admin cấu hình được org (Company/Department/Team/Staff) và vai trò.
- Ba trợ lý AI chạy trong app qua endpoint BYOK do admin cấu hình — không còn copy-paste
  sang công cụ ngoài.
- Khách hàng tự triển khai được bằng một gói Docker trên máy chủ VN của họ; dữ liệu ở lại
  trên máy chủ đó.

## 2. Kiến trúc tổng thể

Một tiến trình Node duy nhất, đóng gói Docker, chạy trên máy chủ của khách hàng:

```
Máy chủ VN của khách hàng (on-prem / Viettel / FPT VPS)
└─ Docker: một tiến trình Node (TypeScript)
   ├─ API layer (REST, /api/v1/…)  auth · org · roles · canvas · AI proxy · settings
   ├─ Service layer                logic nghiệp vụ dùng chung cho MỌI client
   ├─ SQLite (mặc định)            toàn bộ dữ liệu, nằm trên đĩa của khách  (Postgres tùy chọn)
   └─ Static frontend              HTML/CSS/JS hiện tại, tiến hóa tại chỗ
                                   → chỉ gọi ra ngoài tới endpoint AI mà admin cấu hình
```

**API-first — cam kết kiến trúc cốt lõi.** Backend phơi ra một **JSON REST API có tài liệu
(OpenAPI)**, xác thực bằng **JWT/token**, và **toàn bộ logic nghiệp vụ nằm ở service layer**
bên dưới API. Web frontend chỉ là *client đầu tiên*. Nhờ vậy:

- **API đầy đủ**: có sẵn ngay từ Phase 0.
- **MCP server**: một wrapper Node/TypeScript mỏng bọc *cùng service layer*, phơi ra các
  tool (ví dụ `get_team_status`, `read_canvas`, `create_canvas_version`). MCP SDK vốn ưu
  tiên TypeScript nên backend viết bằng TypeScript.
- **Mobile app**: là một client mới dùng chung API + JWT. Điều kiện phải có từ Phase 0:
  **JWT (không chỉ cookie)**, **CORS**, **versioning `/api/v1`**, và **không đặt logic ở
  frontend**.

**Hai chế độ chạy, một bản build:** `DEMO_MODE=on` seed org mẫu + canvases từ `data.js` và
cho phép trải nghiệm nhanh; triển khai thật khởi động rỗng và admin tạo công ty. Cùng một
image.

### Nguyên tắc thiết kế

- Không bao giờ đặt logic nghiệp vụ ở frontend; giữ ở service layer để API, MCP và mobile
  dùng chung một cách hiện thực.
- Mỗi đơn vị (module) có một mục đích rõ ràng, giao tiếp qua interface rõ ràng, kiểm thử
  độc lập được.

## 3. Tech stack

Đã chốt (so sánh phương án đã thực hiện trong quá trình brainstorm):

- **Backend:** Node.js viết bằng **TypeScript** (Express hoặc Fastify).
- **CSDL:** **SQLite mặc định** (một file, không cần quản trị — hợp on-prem/VPS);
  **Postgres tùy chọn** cho khách hàng lớn. Schema giống nhau; body JSON dùng JSON text
  (SQLite) hoặc JSONB (Postgres).
- **Frontend:** giữ và tiến hóa **HTML/CSS/JS thuần hiện tại** — trở thành client đầu tiên
  của API. (Rewrite sang SPA hoặc chuyển sang Laravel đã cân nhắc và loại: rewrite tốn công
  và bỏ phí UI đang chạy; ưu tiên đường ngắn nhất từ demo → sản phẩm.)
- **Đóng gói:** Docker image + `docker-compose.yml`.
- **AI:** endpoint **OpenAI-compatible** cấu hình được (base URL + key + model), gọi qua
  backend proxy.

## 4. Thứ tự xây dựng (build order)

Một tài liệu thiết kế; triển khai theo từng phase, mỗi phase ship và demo được độc lập.

| Phase | Cung cấp | Vì sao thứ tự này |
|---|---|---|
| **0 · Nền tảng** | Node API + SQLite, phục vụ frontend hiện tại, **đăng nhập thật** thay màn chọn vai trò, session/JWT. Chuyển `data.js` → DB dạng seed. API-first + JWT + CORS + `/api/v1` ngay từ đầu. | Chưa persist + chưa auth thật thì chưa có gì "thật". Mọi thứ khác dựng trên lớp này. |
| **1 · Org & vai trò** | CRUD **Company → Department → Team → Staff**, tài khoản người dùng, gán vai trò, thực thi phân quyền (ai xem/sửa canvas nào). Bắt đầu khu vực admin. | Làm cho app "dùng cho tổ chức". Cần trước khi canvas thuộc về người/đội thật. |
| **2 · Canvas trong app** | Canvas trở thành sửa được, lưu được, có version trong DB; gộp **Canvas Online** (form/nhập/xuất) vào app chính. | Nửa đầu của "mọi tính năng bên trong". Phụ thuộc mô hình org (chủ canvas). |
| **3 · AI qua BYOK** | Cài đặt AI của admin (endpoint/key/model), backend AI proxy, gộp **Canvas Session Renderer + Canvas Coach** vào app. | Nửa sau của "tính năng bên trong". Phụ thuộc có canvas thật để thao tác. |
| **4 · Coaching Report + đóng gói** | Gộp **Coaching Report** (ORACLE Coaching Grader, dùng lại AI proxy Phase 3); Docker bundle, chế độ demo seed, runbook triển khai VN. | Hoàn tất "không nhảy ra công cụ ngoài" và làm cho sản phẩm ship được cho khách. |

## 5. Mô hình dữ liệu

Mỗi lần triển khai của khách chứa **một company** (dữ liệu của họ, trên máy chủ họ), nhưng
`company` vẫn là một bảng thật để không cản trở multi-company sau này và để demo seed sạch.

```
company        id · name · settings(json)
department     id · company_id → company · name
team           id · department_id → department · name
user           id · company_id · name · email · password_hash
               · title (free text, vd "Trưởng PGD Quận 7")
               · department_id? · team_id?          ← vị trí trong org
               · manager_id? → user                 ← cây báo cáo / coaching
role           id · key (admin|manager|member|owner) · label
user_role      user_id · role_id                    ← một user có thể giữ >1 vai trò

canvas         id · company_id · owner_user_id → user · name · series(json)
canvas_version id · canvas_id · v · week · date · stage · mode · change
               · created_by · created_at
               · body(json)   ← toàn bộ tài liệu schema 3.0: goal, kr, outputs,
                                 behaviors, boxes, actions, risks, plan,
                                 observed, reviews
setting        company_id · key · value(json)       ← AI endpoint/model/key(mã hoá),
                                                       demo_mode, branding
refresh_token  id · user_id · token_hash · expires   ← thu hồi JWT / mobile
coaching_report id · canvas_id · body(json) · created_by · date   ← Phase 4
```

### Quyết định thiết kế

1. **Tách hai khái niệm, không dùng một chuỗi `role`.** Chuỗi tự do hiện tại
   (`"Giám đốc vùng HCM"`) tách thành: (a) **vị trí org + báo cáo** (`department_id`,
   `team_id`, `manager_id`) — điều khiển "đội của tôi"/blockers; và (b) **vai trò phân
   quyền** (`admin`/`manager`/`member`) — điều khiển được làm gì; cộng **title** tự do để
   hiển thị. Chuỗi cũ trở thành `title`.
2. **`manager_id` tường minh**, không suy ra từ cây — trực tiếp phục vụ logic dashboard
   hiện có (subtree, `blockersOwnedBy`) và bền vững khi tổ chức tái cấu trúc.
3. **Body của canvas version lưu dạng một tài liệu JSON** (+ cột metadata có index), không
   normalize thành các bảng boxes/actions/outputs. Schema 3.0 được sửa như một khối và vốn
   đã nhập/xuất dưới dạng tài liệu, nên JSON giữ nó là nguồn sự thật và làm import/export
   của Canvas Online đơn giản.

## 6. Vai trò & phân quyền

Vai trò **cộng dồn** (một user giữ nhiều vai trò — vì thế `user_role` là many-to-many).

| Vai trò | Điều khiển |
|---|---|
| **owner** | Chủ bản triển khai. Toàn quyền, gồm mọi canvas và mọi cài đặt. Thường một người. |
| **admin** | *Cấu hình*: department/team, tài khoản, gán vai trò, **cài đặt AI/BYOK**, branding, demo mode. **Không** tự động được đọc nội dung canvas của mọi người. |
| **manager** (leader/coach) | *Nội dung trong subtree báo cáo của mình*: xem/sửa canvas của người dưới theo chuỗi `manager_id`, chạy AI và 1-1 trên họ, thấy dashboard "Cần bạn xử lý" và cây đội. Ứng với Giám đốc vùng / Trưởng PGD / Tổ trưởng. |
| **member** (staff) | Chỉ **canvas của chính mình**: xem/sửa, dùng AI trên nó. Không thấy ai khác. Vai trò mặc định khi tạo user. |

**Quy tắc lõi — quyền truy cập nội dung canvas** (thực thi ở service layer, không bao giờ ở
frontend):

> Được xem/sửa một canvas nếu bạn là `owner`, **hoặc** bạn là chủ canvas (member trên
> canvas của mình), **hoặc** chủ canvas nằm trong subtree báo cáo của bạn (manager). Một
> `admin` đơn thuần **không** tự động được truy cập nội dung canvas.

Cố ý tách **ai cấu hình hệ thống** (admin) khỏi **ai được đọc nội dung coaching của người
khác** (theo tuyến báo cáo) — hợp với "chúng ta không sở hữu dữ liệu" và quyền riêng tư của
tổ chức. Lãnh đạo cao nhất chỉ cần giữ **cả** `manager` (đỉnh cây → thấy toàn cây) **và**
thường cả `admin`. Một IT admin thuần chỉ nhận `admin`.

**Các rào khác:** cấu hình key BYOK → chỉ `admin`/`owner`; CRUD org/user → `admin`/`owner`;
gọi AI trên một canvas → bất kỳ ai sửa được canvas đó.

## 7. AI qua BYOK

**Cấu hình (chỉ admin), lưu theo company, mã hoá khi lưu:** một **base URL + API key +
model** kiểu OpenAI-compatible, cùng công tắc **bật/tắt AI**. Vì là endpoint cấu hình được,
khách hàng khắt khe về dữ liệu có thể trỏ tới LLM nội bộ/VN; bản demo trỏ tới Claude. Chưa
cấu hình key → tính năng AI hiện thông báo "chưa bật".

**Key không bao giờ ở trình duyệt — backend proxy.** Frontend/mobile/MCP đều gọi
`/api/v1/ai/...`; backend gắn key rồi gọi tới endpoint đã cấu hình, stream kết quả về (SSE).
An toàn hơn gọi LLM từ trình duyệt, là cách duy nhất để mobile và MCP dùng lại, và cho admin
một nơi duy nhất kiểm soát dữ liệu đi đâu. **System prompt của các trợ lý nằm ở server**
(port từ hướng dẫn Claude Project / Custom GPT hiện tại), dưới dạng **template có version**.

### Ba trợ lý (dùng chung AI proxy)

- **Canvas Session Renderer** (Phase 3) — input: canvas hiện tại + ghi chú phiên (hoặc một
  báo cáo ORACLE). Model trả về **nội dung canvas dạng Markdown canonical**; app dùng **bộ
  import sẵn có** (Canvas Online nhập với 0 cảnh báo) để parse thành JSON schema 3.0 và lưu
  thành **bản nháp version mới** để người dùng xem lại/sửa trước khi chốt. Kèm màn so sánh
  v(n) → v(n+1).
- **Canvas Coach** (Phase 3) — input: một canvas. Output: **chấm rubric v3.0 (/100)** +
  **coach cải tiến theo ORACLE**, hiển thị cạnh canvas (cố vấn, không tạo version). Giữ luồng
  *consent-first* và quy tắc epistemic/safety.
- **ORACLE Coaching Grader** (Phase 4) — input: transcript phiên 1-1. Output: chấm kỹ năng
  *coach* theo **ORACLE-v3** → sinh ra **Coaching Report**. Dùng lại AI proxy của Phase 3.

### App tự lo file, AI chỉ lo nội dung

Renderer bản cũ phải dùng code-execution của nhà cung cấp để tạo .xlsx/.html. Trong app,
khả năng xuất Excel/PDF/PNG đã có (`assets/export.js` + Canvas Online). Nên AI chỉ sinh
**nội dung**; xuất file do app làm — sạch hơn, không phụ thuộc code-execution của LLM.

### An toàn

- Consent trước khi xử lý dữ liệu (Canvas Coach); khuyến nghị ẩn danh tên/số nhạy cảm.
- Nhãn Fact / Interpretation / Assumption / Hypothesis / Recommendation.
- **Coi nội dung canvas là dữ liệu không tin cậy** (chống prompt injection): chỉ dẫn bên
  trong nội dung không được ghi đè system prompt.
- Không bịa nguồn, kết quả hay observed evidence; không nâng Stage khi thiếu bằng chứng.

## 8. Xác thực & đóng gói triển khai

**Xác thực (Phase 0):** đăng nhập email + mật khẩu (`password_hash` bcrypt/argon2), cấp
**JWT access token + refresh token** (bảng `refresh_token` để thu hồi, phục vụ cả mobile).
Bỏ hẳn màn chọn vai trò giả.

**Lần chạy đầu (first-run):** DB rỗng và không ở demo mode → wizard tạo tài khoản **owner**
+ tên công ty. `DEMO_MODE=on` → tự seed org mẫu + canvases từ `data.js`, cho đăng nhập
nhanh.

**Cấu hình qua biến môi trường:** `DEMO_MODE`, `DB` (đường dẫn sqlite hoặc URL postgres),
`JWT_SECRET`, `APP_KEY` (khoá mã hoá dùng để mã hoá API key BYOK khi lưu). Không hardcode bí
mật.

**Đóng gói (Phase 4):** một Docker image + `docker-compose.yml`; mặc định SQLite (một file,
không cần quản trị DB) — hợp on-prem/VPS Viettel/FPT. **Sao lưu = copy file SQLite** (hoặc
`pg_dump` nếu dùng Postgres). Kèm **runbook triển khai tiếng Việt**: chạy trên VPS, cấu hình
domain/HTTPS, sao lưu, cập nhật phiên bản.

**Không có gì rời khỏi máy khách** trừ lời gọi tới endpoint AI mà admin tự cấu hình.

## 9. Nguồn để port (đầu vào cho Phase 3–4)

Từ `/Volumes/SS/projects/gwp-canvas-performance-architecture`:

- `canvas-session-renderer/01_project_instruction.md` — system prompt Renderer (v2.3.0),
  output contract schema 3.0, enums, options block.
- `canvas-coach-bot/04_master_instruction.md`, `05_prompt_stack.md`,
  `knowledge_canvas_coach.md` — Canvas Coach 3.0, rubric v3.0, phương pháp luận canonical.
- `Performance_Architecture_Canvas_GoWise.xlsx` — layout canvas chuẩn cho xuất Excel.

Từ `/Volumes/SS/projects/gwp_chatbot_oracle`:

- `oracle-coaching-model.md` — rubric ORACLE-v3 cho Coaching Report grader.
- `sample-transcript.txt`, `scripts/validate_oracle_output.py` — mẫu & kiểm định output.

## 10. Nằm ngoài phạm vi (YAGNI cho lần này)

- Normalize toàn bộ canvas thành nhiều bảng con (giữ JSON document).
- Multi-company thật trong một lần triển khai (mô hình có sẵn, chưa xây UI).
- MCP server và mobile app (kiến trúc sẵn sàng; là dự án riêng ở bước sau).
- SSO/LDAP, audit log nâng cao (có thể thêm sau nếu khách yêu cầu).
