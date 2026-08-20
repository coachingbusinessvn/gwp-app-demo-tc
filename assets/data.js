/* ============================================================
   Dữ liệu demo — TOÀN BỘ LÀ GIẢ ĐỊNH, đã ẩn danh hóa.
   Nội dung canvas lấy từ bộ mẫu đã duyệt (canvas-session-renderer/samples/):
   TC-1 PGD Quận 7 · TC-2 Thu hồi nợ sớm · TC-3 Thẩm định · TC-5 Tuyển dụng.
   ============================================================ */
"use strict";

const BOXES = [
  "Kỳ vọng & Phản hồi","Công cụ & Nguồn lực","Hệ quả & Ghi nhận",
  "Kiến thức & Kỹ năng","Vai trò & Quyền hạn","Động lực & Ưu tiên"
];
/* Tên đầy đủ song ngữ theo schema 3.0 — dùng khi xuất Markdown/Excel */
const BOXES_FULL = [
  "Kỳ vọng & Phản hồi | Expectations & Feedback",
  "Công cụ & Nguồn lực | Tools & Resources",
  "Hệ quả & Ghi nhận | Consequences & Recognition",
  "Kiến thức & Kỹ năng | Knowledge & Skills",
  "Vai trò & Quyền hạn | Role & Authority",
  "Động lực & Ưu tiên | Motivation & Priorities"
];

/* ---------- Cây tổ chức 3 tầng ---------- */
const PEOPLE = {
  l1: {id:"l1", name:"Trần Hải Đăng", role:"Giám đốc vùng HCM", level:1, canvas:"reg"},
  p7: {id:"p7", name:"Phạm Thu Hà", role:"Trưởng PGD Quận 7", level:2, canvas:"tc1"},
  thn:{id:"thn",name:"Vũ Quốc Bảo", role:"Tổ trưởng Thu hồi nợ sớm", level:2, canvas:"tc2"},
  td: {id:"td", name:"Hoàng Anh Tuấn", role:"Trưởng nhóm Thẩm định tài sản", level:2, canvas:"tc3"},
  hr: {id:"hr", name:"Mai Khánh Linh", role:"Chuyên viên Tuyển dụng khối vận hành", level:2, canvas:"tc5"},
  s1: {id:"s1", name:"Lê Văn Sơn", role:"Chuyên viên tư vấn — PGD Quận 7", level:3, canvas:null},
  s2: {id:"s2", name:"Đỗ Minh Thư", role:"Chuyên viên tư vấn — PGD Quận 7", level:3, canvas:null},
  s3: {id:"s3", name:"Ngô Thanh Tùng", role:"Phó tổ Thu hồi nợ sớm", level:3, canvas:null},
  s4: {id:"s4", name:"Bùi Hải Yến", role:"Nhân viên thu hồi nợ", level:3, canvas:null},
  s5: {id:"s5", name:"Trịnh Gia Huy", role:"Nhân viên thẩm định", level:3, canvas:null}
};
const ORG = { id:"l1", children:[
  {id:"p7", children:[{id:"s1",children:[]},{id:"s2",children:[]}]},
  {id:"thn",children:[{id:"s3",children:[]},{id:"s4",children:[]}]},
  {id:"td", children:[{id:"s5",children:[]}]},
  {id:"hr", children:[]}
]};

/* ---------- Canvas ---------- */
/* Mỗi canvas có nhiều bản theo tuần; bản mới nhất đứng đầu mảng `versions`. */
const CANVAS = {};

CANVAS.tc1 = {
  id:"tc1", personId:"p7", name:"PGD Quận 7 · Quý 4/2026",
  versions:[
    { v:"v3", week:"Tuần 33", date:"2026-08-12", stage:"DRAFT", mode:"RAPID_DRAFT",
      change:"Chốt canvas sau phiên 1-1: gán chủ sở hữu danh sách gọi lại, đặt nhịp phân công 8h30.",
      owner:"Giám đốc vùng (coach) — phiên 1-1 với Trưởng PGD Quận 7, ngày 12/08/2026",
      goal:"Tăng năng lực giải ngân của PGD Quận 7 bằng cách khai thác có hệ thống tệp khách cũ — khách hết hạn lãi chưa quay lại và khách cũ có nhu cầu vay lại.",
      context:"Một phòng giao dịch, trong phạm vi Quý 4/2026. Nguồn khách hiện tại chủ yếu đến từ khách cũ giới thiệu, trong khi danh sách khách hết hạn lãi được hệ thống xuất mỗi sáng lại chưa có người phụ trách.",
      kr:{metric:"Giải ngân trung bình / tháng", cur:"2,1 tỷ", tgt:"2,8 tỷ", due:"31/12/2026",
          cs:"Doanh số giải ngân bình quân tháng, đo trên hệ thống core"},
      outputs:[
        {name:"Tỷ lệ khách hết hạn lãi được gọi lại trong 48h", cur:"20%", tgt:"90%", due:"31/12/2026",
         cs:"Khách trong danh sách hệ thống xuất mỗi sáng được liên hệ và ghi nhận kết quả trong vòng 48h"},
        {name:"Tỷ lệ khách cũ quay lại vay lại", cur:"35%", tgt:"45%", due:"31/12/2026",
         cs:"Khách cũ phát sinh khoản vay mới trong kỳ / tổng khách cũ đến hạn, đo trên hệ thống core"}],
      direction:"Nâng cao chất lượng vận hành tệp khách cũ dựa trên nhịp phân công – theo dõi hằng ngày nhằm tăng giải ngân từ 2,1 lên 2,8 tỷ/tháng.",
      logic:"Khoảng cách lớn nhất không nằm ở thiếu dữ liệu hay thiếu nỗ lực, mà ở chỗ danh sách đã có nhưng không ai sở hữu — bằng chứng: danh sách khách hết hạn lãi “hệ thống xuất mỗi sáng nhưng không ai phụ trách”.",
      behaviors:[
        {actor:"Trưởng PGD", beh:"Phân công danh sách gọi lại lúc 8h30 mỗi sáng và check kết quả cuối ngày trên bảng chung",
         ctx:"Đầu ngày và cuối ngày", out:"Cả hai Output", sign:"Mỗi khách có tên người phụ trách; cuối ngày bảng chung có kết quả", freq:"Hàng ngày"},
        {actor:"Chuyên viên tư vấn", beh:"Gọi lại khách được phân công trong 48h và ghi kết quả lên bảng chung",
         ctx:"Sau phân công buổi sáng", out:"Tỷ lệ gọi lại 48h", sign:"Có cuộc gọi và dòng kết quả trong 48h", freq:"Hàng ngày"},
        {actor:"Trưởng PGD", beh:"Nghe lại 5 cuộc gọi mỗi tuần và góp ý cho nhân viên",
         ctx:"Trong tuần làm việc", out:"Tỷ lệ khách cũ quay lại", sign:"5 cuộc được nghe, có ghi chú góp ý", freq:"Hàng tuần"}],
      boxes:[
        {cond:"Chuẩn “gọi lại trong 48h” được công bố thành cam kết chung", ev:"Chuẩn 48h chưa nêu thành yêu cầu chính thức; nhân viên mới hay bỏ qua bước gọi lại", gap:"Cao", pri:"Cao", beh:"Phân công danh sách gọi lại lúc 8h30 mỗi sáng và check kết quả cuối ngày trên bảng chung", act:"Công bố chuẩn 48h trong họp đầu ngày 13/08", own:"Trưởng PGD"},
        {cond:"Có nguồn đo kết quả gọi lại hằng ngày", ev:"Danh sách đã có; chưa có báo cáo kết quả gọi lại — đang chờ IT", gap:"Cao", pri:"Cao", beh:"Phân công danh sách gọi lại lúc 8h30 mỗi sáng và check kết quả cuối ngày trên bảng chung", act:"Dùng bảng chung thủ công từ 13/08; song song xin IT", own:"Giám đốc vùng"},
        {cond:"Ghi nhận nhân viên gọi lại đúng hạn", ev:"Chưa có cơ chế ghi nhận; chỉ chú ý khi kết quả cuối tháng không đạt", gap:"Trung bình", pri:"Trung bình", beh:"Gọi lại khách được phân công trong 48h và ghi kết quả lên bảng chung", act:"Nêu tên nhân viên đạt 48h trong check cuối ngày", own:"Trưởng PGD"},
        {cond:"Nhân viên biết cách mở đầu và xử lý từ chối", ev:"Nhân viên tư vấn mới vào nghề; chưa vững kỹ năng gọi lại", gap:"Trung bình", pri:"Cao", beh:"Nghe lại 5 cuộc gọi mỗi tuần và góp ý cho nhân viên", act:"Nghe 5 cuộc/tuần, rút 1 mẫu thoại tốt để chia sẻ", own:"Trưởng PGD"},
        {cond:"Mỗi khách trong danh sách có đúng một người phụ trách", ev:"Danh sách “không ai phụ trách”", gap:"Cao", pri:"Cao", beh:"Phân công danh sách gọi lại lúc 8h30 mỗi sáng và check kết quả cuối ngày trên bảng chung", act:"Phân công tên cụ thể ngay tại danh sách mỗi sáng", own:"Trưởng PGD"},
        {cond:"Có khung giờ cố định cho việc gọi lại", ev:"Việc gọi lại bị khách tại quầy chen ngang; chưa có khung giờ riêng", gap:"Trung bình", pri:"Cao", beh:"Gọi lại khách được phân công trong 48h và ghi kết quả lên bảng chung", act:"Chốt khung giờ gọi cố định trong ngày", own:"Trưởng PGD"}],
      actions:[
        {act:"Phân công danh sách gọi lại lúc 8h30 và check kết quả cuối ngày", start:"2026-08-13", due:"2026-08-26", own:"Trưởng PGD", sup:"Chuyên viên tư vấn", cri:"Đủ 10 ngày làm việc có phân công và kết quả", st:"Chưa bắt đầu", risk:"Trưởng PGD vắng — chỉ định người thay trước"},
        {act:"Xin IT xuất báo cáo gọi lại tự động hằng ngày", start:"2026-08-13", due:"2026-08-19", own:"Giám đốc vùng", sup:"IT", cri:"IT xác nhận lịch bàn giao hoặc báo cáo chạy thử", st:"Chưa bắt đầu", risk:"IT không kịp — giữ bảng chung thủ công"},
        {act:"Nghe lại 5 cuộc gọi mỗi tuần và góp ý", start:"2026-08-13", due:"2026-08-26", own:"Trưởng PGD", sup:"Chuyên viên tư vấn", cri:"Mỗi tuần 5 cuộc được nghe, có ghi chú", st:"Chưa bắt đầu", risk:"Không truy được ghi âm — nghe trực tiếp"}],
      risks:["Giả định: bảng chung thủ công đủ tin cậy để đo tỷ lệ 48h trong 2 tuần đầu.",
             "Giả định: tệp khách cũ đủ lớn để cõng mức tăng +33% giải ngân.",
             "Rủi ro: việc “xin IT” chưa có cam kết từ IT — Measurement Plan dài hạn treo vào việc này.",
             "Cần xác nhận: cách tính baseline 20% (đo trên mẫu nào, kỳ nào)."],
      plan:[
        {date:"2026-08-19", layer:"BEHAVIOR", metric:"Số ngày có phân công 8h30 và check cuối ngày", base:"0 ngày", tgt:"5/5 ngày", src:"Bảng chung của PGD", col:"Trưởng PGD", ver:"Giám đốc vùng"},
        {date:"2026-08-26", layer:"OUTPUT", metric:"Tỷ lệ gọi lại 48h; tỷ lệ khách cũ quay lại", base:"20%; 35%", tgt:"≥ 60% ở tuần 2", src:"Bảng chung + hệ thống core", col:"Trưởng PGD", ver:"Giám đốc vùng"},
        {date:"2026-12-31", layer:"RESULT", metric:"Giải ngân trung bình / tháng", base:"2,1 tỷ", tgt:"2,8 tỷ", src:"Hệ thống core", col:"Trưởng PGD", ver:"Giám đốc vùng"}],
      observed:[],
      reviews:[
        {cp:"Sau 7 ngày (tuần 1)", date:"2026-08-19", ver:"Giám đốc vùng"},
        {cp:"Sau 2 tuần (tuần 2)", date:"2026-08-26", ver:"Giám đốc vùng"},
        {cp:"Cuối kỳ", date:"2026-12-31", ver:"Giám đốc vùng"}]
    },
    { v:"v2", week:"Tuần 32", date:"2026-08-05", stage:"DRAFT", mode:"GUIDED",
      change:"Bổ sung Critical Output thứ hai (tỷ lệ khách cũ quay lại) sau khi rà số liệu core.", brief:true },
    { v:"v1", week:"Tuần 31", date:"2026-07-29", stage:"DRAFT", mode:"GUIDED",
      change:"Bản đầu tiên: Goal + Key Result giải ngân, chưa có 6 Boxes.", brief:true }
  ],
  series:{
    axes:{behavior:{lb:"Nhịp phân công + nghe lại (BEHAVIOR)", base:0, tgt:100, unit:"% ngày đạt"},
          output:{lb:"Gọi lại trong 48h (OUTPUT)", base:20, tgt:90, unit:"%"},
          result:{lb:"Giải ngân/tháng (RESULT)", base:2.1, tgt:2.8, unit:" tỷ"}},
    points:[
      {wk:"T31", behavior:0,  output:20, result:2.1},
      {wk:"T32", behavior:0,  output:22, result:2.1},
      {wk:"T33", behavior:10, output:24, result:2.15}]
  }
};

CANVAS.tc2 = {
  id:"tc2", personId:"thn", name:"Thu hồi nợ sớm miền Nam Q3/2026",
  versions:[
    { v:"v2", week:"Tuần 33", date:"2026-08-12", stage:"PILOTING", mode:"GUIDED",
      change:"Thêm hành vi đòn bẩy “bàn giao trực ca khiếu nại”; ghi 3 dòng Observed thật; cuộc gọi đạt chuẩn 65% → 78%.",
      owner:"Giám đốc vùng HCM (coach) — phiên 1-1 với Tổ trưởng, 12/08/2026",
      goal:"Giảm nợ chuyển nhóm bằng cách nâng chất lượng liên hệ sớm với khách quá hạn, đúng chuẩn thu hồi nợ văn minh.",
      context:"Tổ thu hồi nợ sớm (nhóm 2, quá hạn 30–60 ngày), miền Nam, trong Q3/2026.",
      kr:{metric:"Tỷ lệ hồ sơ nhóm 2 xử lý xong trong 30 ngày", cur:"58%", tgt:"70%", due:"2026-09-30",
          cs:"Đo trên hệ thống collection, tính theo tháng"},
      outputs:[{name:"Cuộc gọi đạt chuẩn chất lượng", cur:"65% (baseline 15/07; đo 12/08: 78%)", tgt:"85%", due:"2026-09-30",
                cs:"Chấm theo checklist QA 10 điểm, mẫu 20 cuộc/tổ/tuần"}],
      direction:"Nâng chất lượng cuộc gọi sớm dựa trên kịch bản chuẩn và dữ liệu hồ sơ nhằm nâng tỷ lệ xử lý nhóm 2 trong 30 ngày từ 58% lên 70%.",
      logic:"Chấm QA có biên bản bắt buộc nên sống sót khi lịch bị chèn; role-play không có chứng cứ nên bị cắt đầu tiên — khoảng cách nằm ở xung đột vai trò của tổ trưởng, không phải thiếu cam kết.",
      behaviors:[
        {actor:"Nhân viên thu hồi nợ", beh:"Đọc kỹ hồ sơ trước khi gọi, mở đầu bằng xác nhận hoàn cảnh", ctx:"Mỗi cuộc gọi nhóm 2", out:"Cuộc gọi đạt chuẩn", sign:"Cuộc gọi có đề xuất phương án trả phù hợp", freq:"Mỗi cuộc gọi"},
        {actor:"Tổ trưởng", beh:"Nghe và chấm 20 cuộc gọi mẫu, phản hồi 1-1", ctx:"Hàng tuần", out:"Cuộc gọi đạt chuẩn", sign:"Biên bản chấm QA + phản hồi có chữ ký hai bên", freq:"Hàng tuần"},
        {actor:"Tổ trưởng + Phó tổ", beh:"Bàn giao trực ca khiếu nại cho phó tổ để giữ lịch role-play và chấm QA", ctx:"Sáng thứ 4 hàng tuần", out:"Cuộc gọi đạt chuẩn (bảo vệ 2 hành vi trên)", sign:"Sáng thứ 4 phó tổ trực; role-play và chấm QA diễn ra đúng lịch", freq:"Hàng tuần"}],
      boxes:[
        {cond:"Chuẩn cuộc gọi rõ, phản hồi hàng tuần", ev:"Checklist QA 10 điểm đã ban hành; 4 tuần liên tục chấm đủ 20 cuộc/tuần, có biên bản", gap:"Thấp", pri:"Trung bình", beh:"Nghe và chấm 20 cuộc gọi mẫu, phản hồi 1-1", act:"Duy trì", own:"Tổ trưởng"},
        {cond:"Hồ sơ khách hiện đủ trên một màn hình", ev:"Phải mở 2 hệ thống mới đủ thông tin", gap:"Cao", pri:"Cao", beh:"Đọc kỹ hồ sơ trước khi gọi, mở đầu bằng xác nhận hoàn cảnh", act:"Đề xuất IT gộp màn hình", own:"Giám đốc vùng HCM"},
        {cond:"Ghi nhận cuộc gọi chất lượng, không chỉ số tiền thu", ev:"Thưởng hiện chỉ theo số tiền thu", gap:"Cao", pri:"Cao", beh:"Đọc kỹ hồ sơ trước khi gọi, mở đầu bằng xác nhận hoàn cảnh", act:"Đề xuất thêm tiêu chí QA vào thưởng", own:"Giám đốc vùng HCM"},
        {cond:"Kỹ năng xử lý tình huống khách khó", ev:"Nhân viên mới chiếm 40% tổ; role-play mới chạy được 2/4 buổi", gap:"Trung bình", pri:"Cao", beh:"Đọc kỹ hồ sơ trước khi gọi, mở đầu bằng xác nhận hoàn cảnh", act:"Role-play 30 phút/tuần", own:"Tổ trưởng"},
        {cond:"Nhân viên được chủ động đề xuất phương án trả trong khung", ev:"Mọi phương án phải xin duyệt", gap:"Trung bình", pri:"Trung bình", beh:"Đọc kỹ hồ sơ trước khi gọi, mở đầu bằng xác nhận hoàn cảnh", act:"Ban hành khung phương án chuẩn", own:"Giám đốc vùng HCM"},
        {cond:"Thời gian chấm QA và role-play được bảo vệ", ev:"2 tuần liền tổ trưởng bị kéo vào xử lý ca khiếu nại; role-play chỉ đạt 2/4 buổi dù chấm QA vẫn đủ 4/4 tuần", gap:"Cao", pri:"Cao", beh:"Bàn giao trực ca khiếu nại cho phó tổ để giữ lịch role-play và chấm QA", act:"Bàn giao trực sáng thứ 4 cho phó tổ, từ tuần sau", own:"Tổ trưởng"}],
      actions:[
        {act:"Chấm QA 20 cuộc/tuần và phản hồi 1-1", start:"2026-07-16", due:"2026-08-15", own:"Tổ trưởng", sup:"Giám đốc vùng HCM", cri:"4 tuần liên tục có biên bản chấm", st:"Hoàn thành", risk:"Đã đạt 4/4 tuần — duy trì nhịp"},
        {act:"Role-play tình huống khách khó 30 phút/tuần", start:"2026-07-16", due:"2026-09-09", own:"Tổ trưởng", sup:"QA nội bộ; Phó tổ", cri:"Mỗi nhân viên mới qua 4 buổi", st:"Cần hỗ trợ", risk:"Mới đạt 2/4 buổi do trùng ca khiếu nại — gia hạn và bàn giao trực"},
        {act:"Bàn giao trực ca khiếu nại sáng thứ 4 cho phó tổ", start:"2026-08-19", due:"2026-09-09", own:"Tổ trưởng", sup:"Phó tổ", cri:"4 tuần tới đủ 4 buổi role-play", st:"Chưa bắt đầu", risk:"Phó tổ có thể vướng ca phức tạp — thống nhất ngưỡng chuyển ngược"}],
      risks:["Giả định: phó tổ đủ thẩm quyền và năng lực trực ca khiếu nại sáng thứ 4.",
             "Giả định: mức tăng 65% → 78% đến chủ yếu từ chấm QA, vì role-play mới chạy 50% kế hoạch — cần tách bằng chứng ở vòng đo sau.",
             "Rủi ro: 7 điểm còn lại tới CS 85% khó hơn phần đã đạt.",
             "Cần xác nhận: lịch review tiếp theo để 09/09 theo đề xuất, tổ trưởng chưa chốt."],
      plan:[
        {date:"2026-08-15", layer:"BEHAVIOR", metric:"Số tuần chấm QA đủ 20 cuộc + biên bản", base:"0", tgt:"4/4 tuần", src:"Biên bản QA", col:"Tổ trưởng", ver:"Giám đốc vùng HCM"},
        {date:"2026-08-31", layer:"OUTPUT", metric:"Tỷ lệ cuộc gọi đạt chuẩn", base:"65%", tgt:"≥ 75%", src:"Hệ thống QA", col:"QA nội bộ", ver:"Giám đốc vùng HCM"},
        {date:"2026-09-09", layer:"BEHAVIOR", metric:"Số buổi role-play; số sáng thứ 4 phó tổ trực", base:"2/4; 0/4", tgt:"4/4; 4/4", src:"Lịch role-play + phân công trực", col:"Tổ trưởng", ver:"Giám đốc vùng HCM"},
        {date:"2026-09-30", layer:"RESULT", metric:"Tỷ lệ hồ sơ nhóm 2 xử lý xong trong 30 ngày", base:"58%", tgt:"70%", src:"Hệ thống collection", col:"Data", ver:"Giám đốc Thu hồi nợ"}],
      observed:[
        {date:"2026-08-12", layer:"BEHAVIOR", val:"Chấm QA đạt 4/4 tuần, đủ 20 cuộc/tuần, có biên bản đầy đủ", src:"Biên bản chấm QA 4 tuần (16/07–12/08)", conf:"HIGH", learn:"Hành vi có biên bản bắt buộc thì sống sót khi lịch bị chèn", dec:"CONTINUE", ver:"Giám đốc vùng HCM"},
        {date:"2026-08-12", layer:"BEHAVIOR", val:"Role-play chỉ chạy 2/4 buổi; 2 tuần liền tổ trưởng bị kéo vào ca khiếu nại", src:"Ghi chú 1-1 ngày 12/08/2026", conf:"HIGH", learn:"Nguyên nhân là xung đột vai trò, không phải thiếu cam kết", dec:"ADJUST", ver:"Giám đốc vùng HCM"},
        {date:"2026-08-12", layer:"OUTPUT", val:"Tỷ lệ cuộc gọi đạt chuẩn tăng từ 65% lên 78%", src:"Hệ thống QA; QA nội bộ đã xác nhận", conf:"HIGH", learn:"Vượt mốc ≥ 75% sớm hơn kế hoạch, còn 7 điểm tới CS 85%", dec:"CONTINUE", ver:"Giám đốc vùng HCM"}],
      reviews:[
        {cp:"Sau 4 tuần", date:"2026-08-12", ver:"Giám đốc vùng HCM", be:"Chấm QA 4/4 tuần; role-play 2/4 buổi", oe:"Cuộc gọi đạt chuẩn 65% → 78%", re:"Chưa đủ chu kỳ đo", ok:"Nhịp chấm QA và phản hồi 1-1 duy trì đủ 4 tuần", no:"Role-play bị cắt vì trùng lịch trực ca khiếu nại", ln:"Bàn giao trực cho phó tổ từ tuần sau"},
        {cp:"Sau 8 tuần", date:"2026-09-09", ver:"Giám đốc vùng HCM"}]
    },
    { v:"v1", week:"Tuần 29", date:"2026-07-15", stage:"PILOTING", mode:"GUIDED",
      change:"Bản gốc: 2 hành vi (đọc hồ sơ trước khi gọi, chấm QA 20 cuộc/tuần); Observed còn TBD.", brief:true }
  ],
  series:{
    axes:{behavior:{lb:"Chấm QA + role-play đúng lịch (BEHAVIOR)", base:0, tgt:100, unit:"% buổi đạt"},
          output:{lb:"Cuộc gọi đạt chuẩn (OUTPUT)", base:65, tgt:85, unit:"%"},
          result:{lb:"Hồ sơ nhóm 2 xong ≤30 ngày (RESULT)", base:58, tgt:70, unit:"%"}},
    points:[
      {wk:"T29", behavior:0,  output:65, result:58},
      {wk:"T30", behavior:50, output:68, result:58},
      {wk:"T31", behavior:75, output:72, result:59},
      {wk:"T32", behavior:75, output:75, result:60},
      {wk:"T33", behavior:75, output:78, result:61}]
  }
};

CANVAS.tc3 = {
  id:"tc3", personId:"td", name:"Thẩm định — Giảm lệch giá Q3/2026",
  versions:[
    { v:"v1", week:"Tuần 33", date:"2026-08-12", stage:"DRAFT", mode:"RAPID_DRAFT",
      change:"Bản đầu: chốt nhịp bảng xếp hạng lệch giá theo tuần; giữ số thật 6,5% (tháng 7), không ghi 3% là đã đạt.",
      owner:"(chưa điền)",
      goal:"Nâng độ tin cậy của kết quả định giá tài sản, giảm rủi ro định giá lệch so với giá tham chiếu.",
      context:"Nhóm thẩm định, trong Q3/2026 (hạn 30/09/2026). Hồ sơ lệch quá 5% là rủi ro trực tiếp cho quyết định cấp tín dụng.",
      kr:{metric:"Tỷ lệ hồ sơ định giá lệch quá 5% so với giá tham chiếu", cur:"8% (đầu quý); gần nhất 6,5% (tháng 7/2026)", tgt:"3%", due:"30/09/2026",
          cs:"Đo bằng đối soát lại mẫu ngẫu nhiên hàng tháng; đối soát tháng 8 chưa chạy tại ngày lập canvas"},
      outputs:[
        {name:"Hồ sơ định giá đủ bằng chứng tại thời điểm chốt", cur:"(chưa điền)", tgt:"100% hồ sơ", due:"30/09/2026", cs:"Có đủ ảnh 8 góc theo checklist VÀ ghi nhận đối chiếu giá tham chiếu trước khi chốt"},
        {name:"Hồ sơ trên 50 triệu được nhóm trưởng double-check", cur:"(chưa điền)", tgt:"100%", due:"30/09/2026", cs:"100% hồ sơ trên 50 triệu có dấu vết double-check trước khi chốt"}],
      direction:"Nâng cao chất lượng kiểm soát định giá dựa trên dữ liệu lệch giá theo từng nhân viên theo tuần, nhằm giảm tỷ lệ hồ sơ lệch quá 5% từ 8% xuống 3% trước 30/09/2026.",
      logic:"Hai hành vi kiểm soát đã thống nhất từ trước nhưng không có dữ liệu cho biết chúng có thực sự xảy ra ở từng hồ sơ hay không — nhận định “anh em làm kỹ lắm rồi” dựa trên cảm nhận. Khoảng cách nằm ở khả năng nhìn thấy và phản hồi theo tuần.",
      behaviors:[
        {actor:"Nhân viên thẩm định", beh:"Chụp ảnh tài sản theo checklist 8 góc và đối chiếu giá tham chiếu trước khi chốt hồ sơ", ctx:"Mỗi hồ sơ định giá", out:"Hồ sơ đủ bằng chứng", sign:"Hồ sơ có đủ ảnh 8 góc và ghi nhận đối chiếu trước thời điểm chốt", freq:"Mỗi hồ sơ"},
        {actor:"Nhóm trưởng thẩm định", beh:"Double-check 100% hồ sơ trên 50 triệu trước khi chốt", ctx:"Hồ sơ trên 50 triệu", out:"Hồ sơ >50tr được double-check", sign:"Có dấu vết double-check trước khi chốt", freq:"Mỗi hồ sơ >50tr"},
        {actor:"Nhóm trưởng + cả nhóm", beh:"Mỗi thứ 2 xem bảng xếp hạng lệch giá tuần trước và chọn 1 điểm cần chỉnh trong tuần", ctx:"Đầu tuần, sau khi dashboard chạy", out:"Cả hai Output", sign:"Bảng xếp hạng được mở, nhóm ghi 1 điểm cần chỉnh và người phụ trách", freq:"Hàng tuần"}],
      boxes:[
        {cond:"Có chuẩn lệch giá rõ và nhịp phản hồi hàng tuần tới từng nhân viên", ev:"Phản hồi hiện chỉ theo tháng qua đối soát mẫu; chưa có phản hồi theo tuần", gap:"Cao", pri:"Cao", beh:"Mỗi thứ 2 xem bảng xếp hạng lệch giá tuần trước và chọn 1 điểm cần chỉnh trong tuần", act:"Chốt nhịp review thứ 2 hàng tuần", own:"Trưởng nhóm thẩm định"},
        {cond:"Dashboard theo dõi lệch giá theo từng nhân viên, cập nhật hàng tuần", ev:"Chưa có dashboard; đang là cam kết của trưởng nhóm, hạn 25/08/2026", gap:"Cao", pri:"Cao", beh:"Mỗi thứ 2 xem bảng xếp hạng lệch giá tuần trước và chọn 1 điểm cần chỉnh trong tuần", act:"Hoàn thành dashboard với hỗ trợ của IT", own:"Trưởng nhóm thẩm định"},
        {cond:"Ghi nhận hồ sơ đạt chuẩn bằng chứng, không chỉ nhắc khi có hồ sơ lệch", ev:"(chưa điền) — chưa có dữ liệu; chưa đủ bằng chứng để xếp mức khoảng cách", gap:"", pri:"Trung bình", beh:"Chụp ảnh tài sản theo checklist 8 góc và đối chiếu giá tham chiếu trước khi chốt hồ sơ", act:"Đưa phần ghi nhận vào buổi review thứ 2", own:"Trưởng nhóm thẩm định"},
        {cond:"Cả nhóm hiểu thống nhất cách xác định giá tham chiếu và ngưỡng lệch 5%", ev:"Cần xác nhận — chưa có bằng chứng về mức chênh lệch hiểu biết; chưa đủ bằng chứng để xếp mức khoảng cách", gap:"", pri:"Trung bình", beh:"Chụp ảnh tài sản theo checklist 8 góc và đối chiếu giá tham chiếu trước khi chốt hồ sơ", act:"Rà lại định nghĩa giá tham chiếu ở buổi review đầu tiên", own:"Trưởng nhóm thẩm định"},
        {cond:"Rõ ai sở hữu dashboard, ai duy trì dữ liệu, ai xác nhận số đối soát", ev:"Trưởng nhóm nhận làm dashboard, IT hỗ trợ; Giám đốc rủi ro xác nhận kết quả đối soát", gap:"Thấp", pri:"Trung bình", beh:"Mỗi thứ 2 xem bảng xếp hạng lệch giá tuần trước và chọn 1 điểm cần chỉnh trong tuần", act:"Xác nhận phạm vi hỗ trợ của IT bằng văn bản", own:"Trưởng nhóm thẩm định"},
        {cond:"Nguyên tắc: chỉ ghi nhận số sau khi đối soát chạy; báo cáo phản ánh đúng số thật", ev:"Có đề xuất ghi đạt 3% trước khi đối soát tháng 8 chạy (“ghi là đạt luôn cho đẹp báo cáo quý”)", gap:"Cao", pri:"Cao", beh:"Double-check 100% hồ sơ trên 50 triệu trước khi chốt", act:"Chốt nguyên tắc chỉ ghi số sau đối soát, có người xác nhận", own:"Trưởng nhóm thẩm định"}],
      actions:[
        {act:"Xây dashboard theo dõi lệch giá theo từng nhân viên", start:"2026-08-12", due:"2026-08-25", own:"Trưởng nhóm thẩm định", sup:"IT", cri:"Mỗi thứ 2 có bảng xếp hạng lệch giá tuần trước theo từng nhân viên", st:"Chưa bắt đầu", risk:"IT bận — chốt phạm vi tối thiểu ngay tuần này; nếu chậm, làm bản thủ công"}],
      risks:["Giả định: dữ liệu lệch giá hiện tại truy được về từng nhân viên.",
             "Giả định: đối soát mẫu ngẫu nhiên hàng tháng đủ cỡ mẫu để đọc thay đổi giữa tháng 8 và 9.",
             "Rủi ro: áp lực báo cáo quý khiến số được ghi trước khi đối soát chạy.",
             "Rủi ro: chỉ còn 2 lần đo (05/09 và cuối tháng 9) trước hạn 30/09."],
      plan:[
        {date:"2026-09-01", layer:"BEHAVIOR", metric:"Bảng xếp hạng được mở thứ 2 và nhóm ghi 1 điểm cần chỉnh", base:"0 bảng/tuần", tgt:"1 bảng + 1 điểm mỗi tuần", src:"Dashboard lệch giá + ghi chú review", col:"Trưởng nhóm thẩm định", ver:"Giám đốc rủi ro"},
        {date:"2026-09-05", layer:"RESULT", metric:"Tỷ lệ hồ sơ lệch quá 5%", base:"6,5% (tháng 7/2026)", tgt:"Giảm so với 6,5%; đích 3%", src:"Đối soát mẫu ngẫu nhiên tháng 8", col:"Bộ phận đối soát", ver:"Giám đốc rủi ro"},
        {date:"2026-09-30", layer:"OUTPUT", metric:"Tỷ lệ hồ sơ đủ bằng chứng; tỷ lệ hồ sơ >50tr có double-check", base:"(chưa điền)", tgt:"100%; 100%", src:"Dashboard + hồ sơ đối soát", col:"Trưởng nhóm thẩm định", ver:"Giám đốc rủi ro"},
        {date:"2026-09-30", layer:"RESULT", metric:"Tỷ lệ hồ sơ lệch quá 5%", base:"6,5% (tháng 7/2026)", tgt:"3%", src:"Đối soát mẫu ngẫu nhiên tháng 9", col:"Bộ phận đối soát", ver:"Giám đốc rủi ro"}],
      observed:[],
      reviews:[
        {cp:"Sau 7 ngày", date:"2026-08-19", ver:"Giám đốc rủi ro"},
        {cp:"Sau 2–4 tuần", date:"2026-09-01", ver:"Giám đốc rủi ro"},
        {cp:"Đối soát tháng 8", date:"2026-09-05", ver:"Giám đốc rủi ro"},
        {cp:"Cuối quý", date:"2026-09-30", ver:"Giám đốc rủi ro"}]
    }
  ],
  series:{
    axes:{behavior:{lb:"Nhịp review lệch giá thứ 2 (BEHAVIOR)", base:0, tgt:100, unit:"% tuần có bảng"},
          output:{lb:"Hồ sơ đủ bằng chứng (OUTPUT)", base:0, tgt:100, unit:"%"},
          result:{lb:"Hồ sơ lệch >5% (RESULT, càng thấp càng tốt)", base:8, tgt:3, unit:"%", invert:true}},
    points:[
      {wk:"T30", behavior:0, output:null, result:8},
      {wk:"T31", behavior:0, output:null, result:7.2},
      {wk:"T32", behavior:0, output:null, result:6.5},
      {wk:"T33", behavior:0, output:null, result:null}]
  }
};

CANVAS.tc5 = {
  id:"tc5", personId:"hr", name:"Tuyển dụng & Giữ chân nhân viên PGD",
  versions:[
    { v:"v1", week:"Tuần 33", date:"2026-08-12", stage:"DRAFT", mode:"RAPID_DRAFT",
      change:"Bản phác thảo từ ghi chú 1-1 còn mơ hồ — phần lớn trường chờ số liệu nền.",
      owner:"(chưa điền)",
      goal:"Ổn định đội ngũ nhân viên PGD: vừa tuyển đủ người, vừa giữ được người mới qua giai đoạn đầu.",
      context:"Công tác tuyển dụng và onboarding nhân viên PGD. Giả định cần kiểm chứng: thiếu người → tuyển vội → nghỉ sớm → lại thiếu người.",
      kr:{metric:"Tỷ lệ người mới PGD còn làm việc sau 90 ngày", cur:"(chưa điền)", tgt:"(chưa điền)", due:"(chưa điền)",
          cs:"Tỷ lệ nhân viên PGD vào việc trong kỳ còn làm tại mốc 90 ngày, đếm theo nhóm vào việc cùng tháng"},
      outputs:[
        {name:"Người mới vượt mốc 30 ngày với đánh giá đạt", cur:"(chưa điền)", tgt:"(chưa điền)", due:"(chưa điền)", cs:"Có biên bản đánh giá 30 ngày do trưởng PGD thực hiện, kết quả đạt"},
        {name:"Vị trí PGD được lấp bằng ứng viên đạt chân dung đã thống nhất", cur:"(chưa điền)", tgt:"(chưa điền)", due:"(chưa điền)", cs:"Ứng viên vào việc đạt đủ tiêu chí trong bản chân dung đã chốt trước khi mở tin"}],
      direction:"Nâng cao chất lượng đồng hành 30 ngày đầu giữa trưởng PGD và nhân viên mới nhằm tăng tỷ lệ người mới còn làm việc sau 90 ngày.",
      logic:"Chủ thể tạo ra kết quả giữ người là trưởng PGD, không phải bộ phận tuyển dụng — canvas phải đặt Lever Behavior lên trưởng PGD, nếu không sẽ giao việc sai người.",
      behaviors:[
        {actor:"Trưởng PGD", beh:"Check-in 1-1 với nhân viên mới", ctx:"Tuần đầu và mốc ngày 30", out:"Người mới vượt mốc 30 ngày", sign:"Có ghi chú vướng mắc và việc đã xử lý sau mỗi buổi", freq:"2 lần / người mới"},
        {actor:"Chuyên viên tuyển dụng", beh:"Gọi người mới ngày 7 và ngày 30, chuyển phản hồi về trưởng PGD", ctx:"Sau khi người mới vào việc", out:"Cả hai Output", sign:"Có bản ghi phản hồi và nội dung đã chuyển", freq:"2 lần / người mới"},
        {actor:"Chuyên viên tuyển dụng + Trưởng PGD", beh:"Thống nhất chân dung ứng viên trước khi mở tin tuyển", ctx:"Trước mỗi đợt tuyển", out:"Vị trí được lấp đúng chân dung", sign:"Có bản chân dung được hai bên xác nhận trước khi đăng tin", freq:"Mỗi đợt tuyển"}],
      boxes:[
        {cond:"Trưởng PGD biết rõ mình phải làm gì trong 30 ngày đầu của người mới", ev:"Đề xuất — chưa có kỳ vọng được phát biểu rõ; dữ liệu phiên chỉ nêu “sẽ làm gì đó với các trưởng PGD”", gap:"Cao", pri:"Cao", beh:"Check-in 1-1 với nhân viên mới", act:"Chốt bản kỳ vọng 30 ngày đầu với trưởng PGD", own:"(chưa điền)"},
        {cond:"Có checklist và lịch onboarding chuẩn cho người mới tại PGD", ev:"Đề xuất — chưa thấy công cụ onboarding nào được nhắc trong phiên", gap:"Trung bình", pri:"Cao", beh:"Check-in 1-1 với nhân viên mới", act:"Dựng checklist onboarding 30 ngày bản v1", own:"(chưa điền)"},
        {cond:"Trưởng PGD được ghi nhận theo tỷ lệ giữ được người mới", ev:"Đề xuất — chưa có cơ chế ghi nhận nào được nêu", gap:"Trung bình", pri:"Trung bình", beh:"Check-in 1-1 với nhân viên mới", act:"Đưa tỷ lệ giữ người vào báo cáo định kỳ của PGD", own:"(chưa điền)"},
        {cond:"Trưởng PGD biết cách dẫn dắt và phản hồi cho người mới", ev:"Đề xuất — chưa có dữ liệu; chưa đủ bằng chứng để xếp mức khoảng cách", gap:"", pri:"Trung bình", beh:"Check-in 1-1 với nhân viên mới", act:"Hỏi trực tiếp 2 trưởng PGD trước khi kết luận", own:"(chưa điền)"},
        {cond:"Rõ ai sở hữu 30 ngày đầu của người mới: tuyển dụng hay trưởng PGD", ev:"Đề xuất — ranh giới chưa rõ (“làm gì đó với các trưởng PGD”, “chưa rõ lắm”)", gap:"Cao", pri:"Cao", beh:"Gọi người mới ngày 7 và ngày 30, chuyển phản hồi về trưởng PGD", act:"Phân định owner từng mốc onboarding", own:"(chưa điền)"},
        {cond:"Trưởng PGD có quỹ thời gian cố định cho việc kèm người mới", ev:"Đề xuất — giả định đang ưu tiên chỉ tiêu kinh doanh hơn kèm người mới; cần kiểm chứng", gap:"Cao", pri:"Cao", beh:"Check-in 1-1 với nhân viên mới", act:"Block lịch check-in cố định cho mốc ngày 7 và 30", own:"(chưa điền)"}],
      actions:[
        {act:"Chốt bản kỳ vọng 30 ngày đầu với 1–2 trưởng PGD thí điểm", start:"", due:"", own:"(chưa điền)", sup:"(chưa điền)", cri:"Có bản kỳ vọng được trưởng PGD xác nhận", st:"Chưa bắt đầu", risk:"Trưởng PGD bận chỉ tiêu — gói buổi 45 phút, mang sẵn bản nháp"},
        {act:"Áp check-in ngày 7 và ngày 30 cho toàn bộ người mới trong kỳ thí điểm", start:"", due:"", own:"(chưa điền)", sup:"(chưa điền)", cri:"100% người mới được check-in đủ 2 mốc, có ghi chú", st:"Chưa bắt đầu", risk:"Không có người mới trong 14 ngày — kéo dài kỳ thí điểm"},
        {act:"Lấy số liệu nền: tỷ lệ nghỉ trong 30/60/90 ngày của 6 tháng gần nhất", start:"", due:"", own:"(chưa điền)", sup:"(chưa điền)", cri:"Có bảng số liệu nền cho Key Result", st:"Chưa bắt đầu", risk:"Dữ liệu nhân sự phân tán — chốt một nguồn duy nhất"}],
      risks:["Giả định: hai vấn đề (tuyển chậm, nghỉ sớm) là một vòng lặp nhân quả.",
             "Giả định: trưởng PGD có thể dành thời gian check-in.",
             "Rủi ro: cam kết trong phiên còn ở mức “sẽ làm gì đó” — chưa có owner, hạn, dấu hiệu thành công.",
             "Rủi ro: chưa có bất kỳ số liệu nền nào, nên chưa thể biết thử nghiệm có hiệu quả hay không."],
      plan:[
        {date:"", layer:"BEHAVIOR", metric:"Số buổi check-in ngày 7 / ngày 30 có ghi chú", base:"0 buổi", tgt:"100% người mới đủ 2 mốc", src:"Ghi chú check-in + bản ghi cuộc gọi", col:"(chưa điền)", ver:"(chưa điền)"},
        {date:"", layer:"OUTPUT", metric:"Tỷ lệ người mới vượt mốc 30 ngày với đánh giá đạt", base:"(chưa điền)", tgt:"(chưa điền)", src:"Biên bản đánh giá 30 ngày", col:"(chưa điền)", ver:"(chưa điền)"},
        {date:"", layer:"RESULT", metric:"Tỷ lệ người mới còn làm việc sau 90 ngày", base:"(chưa điền)", tgt:"(chưa điền)", src:"Dữ liệu nhân sự theo nhóm vào việc", col:"(chưa điền)", ver:"(chưa điền)"}],
      observed:[],
      reviews:[{cp:"Sau 7 ngày", date:"", ver:"(chưa điền)"},{cp:"Sau 2–4 tuần", date:"", ver:"(chưa điền)"}]
    }
  ],
  series:{axes:{behavior:{lb:"Check-in ngày 7 / ngày 30 (BEHAVIOR)", base:0, tgt:100, unit:"%"},
                output:{lb:"Vượt mốc 30 ngày đánh giá đạt (OUTPUT)", base:0, tgt:100, unit:"%"},
                result:{lb:"Còn làm sau 90 ngày (RESULT)", base:0, tgt:100, unit:"%"}},
          points:[]}
};

CANVAS.reg = {
  id:"reg", personId:"l1", name:"Vùng HCM · Quý 4/2026",
  versions:[
    { v:"v2", week:"Tuần 33", date:"2026-08-12", stage:"PILOTING", mode:"GUIDED",
      change:"Cập nhật sau vòng 1-1 với 4 quản lý trực tiếp: nhịp coach 1-1 hằng tuần đã chạy đủ 4/4 tuần.",
      owner:"Giám đốc vùng HCM",
      goal:"Nâng năng lực điều hành của đội quản lý trực tiếp để mỗi phòng giao dịch tự vận hành được nhịp cải tiến hằng tuần.",
      context:"4 quản lý trực tiếp (PGD, thu hồi nợ, thẩm định, tuyển dụng), Quý 4/2026. Vùng đang phụ thuộc vào việc Giám đốc vùng trực tiếp gỡ vướng từng ca.",
      kr:{metric:"Tỷ lệ canvas cấp dưới có bằng chứng cập nhật đúng nhịp review", cur:"25%", tgt:"90%", due:"31/12/2026",
          cs:"Canvas có ít nhất 1 dòng Observed Evidence mới kèm ngày, nguồn và người xác nhận trong mỗi kỳ review"},
      outputs:[
        {name:"Số quản lý duy trì được nhịp coach 1-1 hằng tuần với cấp dưới", cur:"1/4", tgt:"4/4", due:"31/12/2026", cs:"Có ghi chú phiên và cam kết của người được coach sau mỗi phiên"},
        {name:"Số canvas cấp dưới đạt stage PILOTING trở lên", cur:"1/4", tgt:"4/4", due:"31/12/2026", cs:"Có thử nghiệm đang chạy và bằng chứng hành vi thật, không chỉ kế hoạch"}],
      direction:"Nâng cao năng lực coach của đội quản lý trực tiếp dựa trên nhịp 1-1 hằng tuần có canvas làm vật chứng, nhằm đưa tỷ lệ canvas cập nhật đúng nhịp từ 25% lên 90%.",
      logic:"Bằng chứng từ 4 phiên 1-1 trong tháng 8: nơi nào quản lý có nhịp coach đều thì canvas có Observed thật (thu hồi nợ), nơi nào chưa có nhịp thì canvas dừng ở kế hoạch (thẩm định, tuyển dụng). Khoảng cách nằm ở nhịp coach, không ở năng lực chuyên môn.",
      behaviors:[
        {actor:"Giám đốc vùng", beh:"Coach 1-1 hằng tuần với từng quản lý trực tiếp, lấy canvas làm vật chứng", ctx:"Hàng tuần", out:"Cả hai Output", sign:"Mỗi phiên có ghi chú và cam kết do quản lý tự chốt", freq:"Hàng tuần"},
        {actor:"Quản lý trực tiếp", beh:"Cập nhật canvas sau mỗi phiên coach và trước mỗi mốc review", ctx:"Sau phiên coach", out:"Tỷ lệ canvas cập nhật đúng nhịp", sign:"Canvas có dòng Observed mới kèm ngày, nguồn, người xác nhận", freq:"Hàng tuần"}],
      boxes:[
        {cond:"Nhịp 1-1 hằng tuần được đặt lịch cố định và không bị dời", ev:"Đang chạy đủ 4/4 tuần trong tháng 8", gap:"Thấp", pri:"Trung bình", beh:"Coach 1-1 hằng tuần với từng quản lý trực tiếp, lấy canvas làm vật chứng", act:"Duy trì", own:"Giám đốc vùng"},
        {cond:"Công cụ điền và chia sẻ canvas dùng chung toàn vùng", ev:"Đã có Canvas Online; 2/4 quản lý còn gửi bản chụp màn hình", gap:"Trung bình", pri:"Cao", beh:"Cập nhật canvas sau mỗi phiên coach và trước mỗi mốc review", act:"Hướng dẫn 15 phút cho 2 quản lý còn lại", own:"Giám đốc vùng"},
        {cond:"Ghi nhận quản lý duy trì nhịp coach, không chỉ nhìn số kinh doanh", ev:"Đề xuất — hiện chỉ nhìn số cuối tháng", gap:"Trung bình", pri:"Trung bình", beh:"Coach 1-1 hằng tuần với từng quản lý trực tiếp, lấy canvas làm vật chứng", act:"Đưa nhịp coach vào phần đánh giá quản lý", own:"Giám đốc vùng"},
        {cond:"Quản lý biết cách đặt câu hỏi thay vì giao việc trong phiên 1-1", ev:"2/4 quản lý vẫn dẫn phiên theo hướng giao việc", gap:"Trung bình", pri:"Cao", beh:"Coach 1-1 hằng tuần với từng quản lý trực tiếp, lấy canvas làm vật chứng", act:"Ngồi cùng 1 phiên của mỗi quản lý và phản hồi sau phiên", own:"Giám đốc vùng"},
        {cond:"Rõ ai sở hữu canvas của từng bộ phận", ev:"Đã rõ: mỗi quản lý sở hữu canvas bộ phận mình", gap:"Thấp", pri:"Thấp", beh:"Cập nhật canvas sau mỗi phiên coach và trước mỗi mốc review", act:"Duy trì", own:"Giám đốc vùng"},
        {cond:"Quỹ thời gian coach được bảo vệ trong tuần bận", ev:"Tuần cao điểm cuối tháng, 2 phiên bị dời sang tuần sau", gap:"Trung bình", pri:"Cao", beh:"Coach 1-1 hằng tuần với từng quản lý trực tiếp, lấy canvas làm vật chứng", act:"Đặt phiên vào đầu tuần thay vì cuối tuần", own:"Giám đốc vùng"}],
      actions:[
        {act:"Chạy nhịp 1-1 hằng tuần với đủ 4 quản lý trực tiếp", start:"2026-07-22", due:"2026-08-26", own:"Giám đốc vùng", sup:"—", cri:"4 tuần liên tục đủ 4 phiên có ghi chú", st:"Đang thực hiện", risk:"Tuần cao điểm bị dời — đặt phiên đầu tuần"},
        {act:"Hướng dẫn Canvas Online cho 2 quản lý còn gửi ảnh chụp", start:"2026-08-13", due:"2026-08-20", own:"Giám đốc vùng", sup:"—", cri:"2 quản lý tự xuất được file canvas", st:"Chưa bắt đầu", risk:"Lịch bận — gộp vào đầu phiên 1-1"}],
      risks:["Giả định: nhịp coach hằng tuần đủ để quản lý tự duy trì canvas mà không cần nhắc.",
             "Rủi ro: tuần cao điểm cuối tháng làm đứt nhịp — đã xảy ra 2 lần trong tháng 8."],
      plan:[
        {date:"2026-08-26", layer:"BEHAVIOR", metric:"Số phiên 1-1 diễn ra có ghi chú / tuần", base:"1/4", tgt:"4/4", src:"Ghi chú phiên coach", col:"Giám đốc vùng", ver:"Giám đốc khối"},
        {date:"2026-09-30", layer:"OUTPUT", metric:"Số canvas cấp dưới đạt PILOTING trở lên", base:"1/4", tgt:"3/4", src:"Canvas của từng bộ phận", col:"Giám đốc vùng", ver:"Giám đốc khối"},
        {date:"2026-12-31", layer:"RESULT", metric:"Tỷ lệ canvas cập nhật đúng nhịp review", base:"25%", tgt:"90%", src:"Canvas của từng bộ phận", col:"Giám đốc vùng", ver:"Giám đốc khối"}],
      observed:[
        {date:"2026-08-12", layer:"BEHAVIOR", val:"4/4 tuần trong tháng 8 đủ 4 phiên 1-1, mỗi phiên có ghi chú và cam kết", src:"Ghi chú phiên 1-1 tháng 8/2026", conf:"HIGH", learn:"Đặt phiên đầu tuần thì không bị dời", dec:"CONTINUE", ver:"Giám đốc khối"},
        {date:"2026-08-12", layer:"OUTPUT", val:"1/4 canvas đạt PILOTING có Observed thật (thu hồi nợ)", src:"Canvas 4 bộ phận, bản 12/08/2026", conf:"MEDIUM", learn:"Nơi có nhịp coach đều thì canvas có bằng chứng thật", dec:"CONTINUE", ver:"Giám đốc khối"}],
      reviews:[
        {cp:"Sau 4 tuần", date:"2026-08-26", ver:"Giám đốc khối"},
        {cp:"Cuối quý", date:"2026-09-30", ver:"Giám đốc khối"}]
    },
    { v:"v1", week:"Tuần 29", date:"2026-07-22", stage:"DRAFT", mode:"GUIDED",
      change:"Bản đầu: đặt mục tiêu nhịp coach 1-1, chưa có bằng chứng.", brief:true }
  ],
  series:{
    axes:{behavior:{lb:"Phiên 1-1 hằng tuần (BEHAVIOR)", base:25, tgt:100, unit:"% phiên đủ"},
          output:{lb:"Canvas đạt PILOTING+ (OUTPUT)", base:25, tgt:100, unit:"%"},
          result:{lb:"Canvas cập nhật đúng nhịp (RESULT)", base:25, tgt:90, unit:"%"}},
    points:[
      {wk:"T29", behavior:25,  output:25, result:25},
      {wk:"T30", behavior:50,  output:25, result:25},
      {wk:"T31", behavior:75,  output:25, result:30},
      {wk:"T32", behavior:100, output:25, result:35},
      {wk:"T33", behavior:100, output:25, result:40}]
  }
};

/* ---------- Tra cứu ---------- */
function canvasOf(personId){
  const p = PEOPLE[personId];
  return p && p.canvas ? CANVAS[p.canvas] : null;
}
function fullVersion(cv, idx){
  // Bản rút gọn (brief) mượn khung nội dung của bản đầy đủ gần nhất,
  // nhưng chỉ giữ bằng chứng đã xảy ra tính tới ngày của chính nó.
  const v = cv.versions[idx];
  if(!v.brief) return v;
  const base = cv.versions.find(x=>!x.brief);
  if(!base) return v;
  const merged = Object.assign({}, base, v, {brief:true});
  const upTo = d => !d || d <= v.date;
  merged.observed = (base.observed||[]).filter(o=>upTo(o.date));
  merged.reviews  = (base.reviews||[]).map(r=>upTo(r.date)?r:{cp:r.cp,date:r.date,ver:r.ver});
  return merged;
}
