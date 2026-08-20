/* App demo TC — logic chung (không thư viện ngoài) */
"use strict";

const SKEY = "gwp-demo-tc-session";
const TODAY = new Date("2026-08-13");

/* ---------- Session ---------- */
function session(){ try{ return JSON.parse(localStorage.getItem(SKEY)||"null") }catch(e){ return null } }
function signIn(personId){ localStorage.setItem(SKEY, JSON.stringify({personId, at:Date.now()})); }
function signOut(){ localStorage.removeItem(SKEY); location.href="index.html"; }
function requireSession(){
  const s = session();
  if(!s || !PEOPLE[s.personId]){ location.replace("index.html"); return null; }
  return PEOPLE[s.personId];
}

/* ---------- Helpers ---------- */
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function qs(k){ return new URLSearchParams(location.search).get(k); }
function initials(name){ const p=name.trim().split(/\s+/); return (p[0][0]+(p[p.length-1][0]||"")).toUpperCase(); }
function dmy(iso){ if(!iso) return "—"; const [y,m,d]=iso.split("-"); return d+"/"+m+"/"+y; }
function daysFrom(iso){ if(!iso) return null; return Math.round((TODAY - new Date(iso))/864e5); }
function stageChip(st){ const c={DRAFT:"draft",PILOTING:"piloting",VALIDATED:"validated"}[st]||"draft";
  return '<span class="chip '+c+'">'+esc(st)+'</span>'; }
function isBlank(v){ const s=String(v||"").trim(); return !s || s==="(chưa điền)" || s==="TBD"; }

/* ---------- Header ---------- */
const LOGO="data:image/svg+xml;utf8,"+encodeURIComponent(
 '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="none" stroke="%23C9A668" stroke-width="3"/><path d="M20 22l7 22 5-14 5 14 7-22" fill="none" stroke="%23E7D0A2" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>');
function renderHeader(me){
  document.body.insertAdjacentHTML("afterbegin",
   '<header class="app"><div class="bar">'+
   '<img class="mark" src="'+LOGO+'" alt="">'+
   '<div><div class="brand">GoWise Partners</div><div class="appname">Performance Follow-up</div></div>'+
   '<div class="spacer"></div>'+
   '<div class="who"><b>'+esc(me.name)+'</b><br>'+esc(me.role)+'</div>'+
   '<a class="out" href="#" id="btnOut">Đăng xuất</a>'+
   '</div></header>');
  document.getElementById("btnOut").addEventListener("click",e=>{e.preventDefault();signOut()});
}
function renderFooter(){
  document.body.insertAdjacentHTML("beforeend",
   '<footer class="app"><b>GoWise Partners</b> · Performance Architecture Canvas schema 3.0 — '+
   'Bản demo, toàn bộ số liệu và tên người là giả định.</footer>');
}

/* ---------- Trạng thái theo dõi của một người ---------- */
function statusOf(personId){
  const cv = canvasOf(personId);
  if(!cv) return {code:"none", label:"Chưa có canvas", tone:"draft"};
  const v = fullVersion(cv,0);
  const age = daysFrom(v.date);
  const overdue = (v.actions||[]).filter(a=>a.due && a.st!=="Hoàn thành" && daysFrom(a.due)>0).length;
  if(overdue) return {code:"overdue", label:overdue+" việc quá hạn", tone:"risk", age};
  if(age>14) return {code:"stale", label:"Chưa cập nhật "+age+" ngày", tone:"risk", age};
  if(v.stage==="DRAFT" && !(v.observed||[]).length) return {code:"draft", label:"Chưa có bằng chứng thực tế", tone:"draft", age};
  return {code:"ok", label:"Đúng nhịp", tone:"validated", age};
}

/* ---------- Việc cần chính người đăng nhập xử lý ---------- */
/* Điều kiện hệ thống mức Cao và hành động mà OWNER là người đang đăng nhập —
   nút thắt do cấp trên giữ thường bị bỏ quên lâu nhất. */
function blockersOwnedBy(me){
  const out=[];
  Object.keys(PEOPLE).forEach(pid=>{
    const cv=canvasOf(pid); if(!cv) return;
    if(pid===me.id) return;
    const v=fullVersion(cv,0);
    (v.boxes||[]).forEach((b,i)=>{
      const own=String(b.own||"");
      if(b.gap==="Cao" && own && (own===me.role || me.role.indexOf(own)>=0 || own.indexOf(me.role)>=0)){
        out.push({person:PEOPLE[pid], canvas:cv, box:BOXES[i], cond:b.cond, act:b.act, since:v.date});
      }
    });
    (v.actions||[]).forEach(a=>{
      const own=String(a.own||"");
      if(a.st!=="Hoàn thành" && own && (own===me.role || own.indexOf(me.role)>=0)){
        out.push({person:PEOPLE[pid], canvas:cv, box:"Action Experiment", cond:a.act, act:"Hạn "+dmy(a.due), since:v.date});
      }
    });
  });
  return out;
}

/* ---------- Chuỗi nhân quả ---------- */
function chainHTML(v){
  const links=[
    {k:"GOAL", t:"Mục tiêu", filled:!isBlank(v.goal)},
    {k:"RESULT", t:"Key Result", filled:v.kr && !isBlank(v.kr.tgt)},
    {k:"OUTPUT", t:(v.outputs||[]).filter(o=>!isBlank(o.name)).length+" Critical Output", filled:(v.outputs||[]).some(o=>!isBlank(o.cur))},
    {k:"BEHAVIOR", t:(v.behaviors||[]).length+" Lever Behavior", filled:(v.behaviors||[]).length>=2},
    {k:"CONDITIONS", t:(v.boxes||[]).filter(b=>!isBlank(b.ev)).length+"/6 ô có bằng chứng", filled:(v.boxes||[]).filter(b=>!isBlank(b.ev)).length>=4},
    {k:"EVIDENCE", t:(v.observed||[]).length?((v.observed||[]).length+" quan sát thật"):"Chưa có quan sát", filled:(v.observed||[]).length>0}
  ];
  return '<div class="chain">'+links.map(l=>
    '<div class="lnk '+(l.filled?"filled":"empty")+'"><b>'+l.k+'</b><span>'+esc(l.t)+'</span></div>').join("")+'</div>';
}

/* ---------- Biểu đồ 3 tầng bằng chứng ---------- */
/* Chuẩn hóa mỗi tầng về % tiến độ từ baseline tới mục tiêu để so được trên cùng một trục. */
function pct(val, ax){
  if(val==null) return null;
  const span = ax.tgt - ax.base;
  if(!span) return null;
  let p = (val - ax.base)/span*100;
  return Math.max(-10, Math.min(115, p));
}
function chartHTML(series){
  const pts = series.points||[];
  if(pts.length<2) return '<p class="note">Chưa đủ dữ liệu theo tuần để vẽ xu hướng — cần ít nhất 2 mốc đo.</p>';
  const W=680,H=250,L=44,R=14,T=16,B=34;
  const iw=W-L-R, ih=H-T-B;
  const x=i=>L+(pts.length===1?iw/2:i*iw/(pts.length-1));
  const y=p=>T+ih-(p/100)*ih;
  const layers=[["behavior",getComputedStyle(document.documentElement).getPropertyValue("--layer-behavior").trim()||"#12304C"],
                ["output",getComputedStyle(document.documentElement).getPropertyValue("--layer-output").trim()||"#B98A48"],
                ["result",getComputedStyle(document.documentElement).getPropertyValue("--layer-result").trim()||"#2F7A5B"]];
  let g="";
  [0,25,50,75,100].forEach(p=>{ g+='<line class="grid" x1="'+L+'" y1="'+y(p)+'" x2="'+(W-R)+'" y2="'+y(p)+'"/>'+
      '<text class="lbl" x="'+(L-8)+'" y="'+(y(p)+3.5)+'" text-anchor="end">'+p+'%</text>'; });
  g+='<line class="tgt" x1="'+L+'" y1="'+y(100)+'" x2="'+(W-R)+'" y2="'+y(100)+'"/>';
  g+='<line class="axis" x1="'+L+'" y1="'+y(0)+'" x2="'+(W-R)+'" y2="'+y(0)+'"/>';
  pts.forEach((p,i)=>{ g+='<text class="lbl" x="'+x(i)+'" y="'+(H-12)+'" text-anchor="middle">'+esc(p.wk)+'</text>'; });

  layers.forEach(([key,color])=>{
    const ax=series.axes[key]; if(!ax) return;
    let d="", started=false, dots="";
    pts.forEach((p,i)=>{
      let raw=p[key];
      if(raw==null) return;
      if(ax.invert){ const span=ax.base-ax.tgt; raw = ax.base - raw; var v = span? (raw/span*100) : null; }
      else var v = pct(raw, ax);
      if(v==null) return;
      d += (started?" L":"M")+x(i)+" "+y(v); started=true;
      dots += '<circle class="dot" cx="'+x(i)+'" cy="'+y(v)+'" r="4" fill="'+color+'"><title>'+
              esc(ax.lb)+" — "+esc(p.wk)+": "+esc(String(p[key]))+esc(ax.unit||"")+'</title></circle>';
    });
    if(d) g+='<path class="ln" d="'+d+'" stroke="'+color+'"/>'+dots;
  });

  const legend = layers.filter(([k])=>series.axes[k]).map(([k,c])=>
    '<span><i style="background:'+c+'"></i>'+esc(series.axes[k].lb)+'</span>').join("");
  return '<div class="chartwrap"><svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img" '+
    'aria-label="Tiến độ ba tầng bằng chứng theo tuần">'+g+'</svg>'+
    '<div class="legend">'+legend+'</div></div>'+
    '<p class="note">Mỗi đường là <b>% tiến độ từ mức nền tới mục tiêu</b> của một tầng bằng chứng, nên ba tầng so được trên cùng một trục. '+
    'Đọc theo thứ tự nhân quả: hành vi đổi trước, đầu ra đổi sau, kết quả đến cuối — khoảng cách giữa ba đường chính là độ trễ bạn đang chờ.</p>';
}

/* ---------- Gợi ý (kiểm tra cấu trúc, không chấm điểm) ---------- */
function recommendations(v){
  const R=[];
  const behNames=(v.behaviors||[]).map(b=>b.beh);
  (v.boxes||[]).forEach((b,i)=>{
    if(b.gap==="Cao" && isBlank(b.act))
      R.push({t:"risk", h:"Ô “"+BOXES[i]+"” ở mức Cao nhưng chưa có hành động", d:"Điều kiện chặn mạnh nhất mà chưa ai làm gì thì tuần sau vẫn sẽ chặn."});
    if(!isBlank(b.beh) && b.beh!=="Cần xác nhận" && behNames.indexOf(b.beh)<0)
      R.push({t:"warn", h:"Ô “"+BOXES[i]+"” trỏ tới hành vi không có ở Bước 3", d:"Tên hành vi phải trùng nguyên văn để giữ liên kết điều kiện ↔ hành vi."});
    if(isBlank(b.gap) && !isBlank(b.cond))
      R.push({t:"warn", h:"Ô “"+BOXES[i]+"” chưa xếp mức khoảng cách", d:"Chưa đủ bằng chứng thì cần một việc đi lấy bằng chứng, đừng để trống mãi."});
    if(b.gap==="Cao" && isBlank(b.own))
      R.push({t:"risk", h:"Ô “"+BOXES[i]+"” mức Cao chưa có người sở hữu", d:"Không có tên người thì điều kiện này không thuộc về ai."});
  });
  const layers=(v.plan||[]).map(p=>p.layer);
  ["BEHAVIOR","OUTPUT","RESULT"].forEach(l=>{
    if(layers.indexOf(l)<0) R.push({t:"warn", h:"Measurement Plan thiếu tầng "+l, d:"Thiếu một tầng thì không đọc được nhân quả giữa hành vi và kết quả."});
  });
  const od=(v.actions||[]).filter(a=>a.due && a.st!=="Hoàn thành" && daysFrom(a.due)>0);
  od.forEach(a=>R.push({t:"risk", h:"Quá hạn "+daysFrom(a.due)+" ngày: "+a.act, d:"Owner "+(a.own||"(chưa có)")+" · hạn "+dmy(a.due)+". Đưa vào phiên 1-1 gần nhất."}));
  (v.actions||[]).forEach(a=>{ if(isBlank(a.own)||isBlank(a.due))
    R.push({t:"warn", h:"Hành động thiếu chủ sở hữu hoặc hạn: "+a.act, d:"Cam kết không có tên và ngày thì không theo dõi được."}); });
  if(!(v.observed||[]).length)
    R.push({t:"warn", h:"Chưa có dòng Observed Evidence nào", d:"Canvas đang là kế hoạch. Sau mốc review đầu tiên, ghi lại quan sát thật kèm ngày, nguồn và người xác nhận."});
  else {
    const ol=(v.observed||[]).map(o=>o.layer);
    if(ol.indexOf("RESULT")<0) R.push({t:"warn", h:"Chưa có bằng chứng ở tầng RESULT", d:"Hành vi và đầu ra đã có số, nhưng kết quả cuối chưa được đo — giữ stage hiện tại cho tới khi có."});
  }
  const age=daysFrom(v.date);
  if(age>14) R.push({t:"risk", h:"Canvas chưa cập nhật "+age+" ngày", d:"Quá một chu kỳ review. Đặt lại lịch 1-1 hoặc chốt lý do nhịp bị đứt."});
  if(!R.length) R.push({t:"ok", h:"Canvas đủ cấu trúc và đang đúng nhịp", d:"Giữ nhịp review và tiếp tục ghi bằng chứng ở cả ba tầng."});
  return R;
}
function recsHTML(R){
  return '<div class="recs">'+R.map(r=>
   '<div class="rec '+(r.t==="risk"?"risk":r.t==="ok"?"ok":"")+'">'+
   '<div class="ic">'+(r.t==="risk"?"⚠":r.t==="ok"?"✓":"◆")+'</div>'+
   '<div class="tx"><b>'+esc(r.h)+'</b><span>'+esc(r.d)+'</span></div></div>').join("")+'</div>';
}
