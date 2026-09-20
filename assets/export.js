/* Xuất canvas ra Markdown (khung gold schema 3.0) và Excel (.xlsx) —
   cùng định dạng với Canvas Online, để dán thẳng vào chatbot hoặc mở bằng Excel.
   Không dùng thư viện ngoài.

   ⚠ DEMO-ERA — không còn được trang nào nạp (task 2.7): xuất file giờ đi qua
   ranh giới được kiểm toán trên server — POST /canvases/:id/export-preview và
   GET /canvases/:id/versions/:versionId/export — rồi web/canvas/export.js +
   editor.js/history.js render bên client. File này giữ lại chỉ để tham chiếu
   (và bị loại khỏi public-build) — không thêm script tag nạp nó vào đâu nữa. */
"use strict";

/* ================= Markdown ================= */
function mdCell(v){ return String(v==null?"":v).trim().replace(/\|/g,"\\|").replace(/\s*\n\s*/g,"; ") }
function mdTable(head, rows){
  const out=["| "+head.join(" | ")+" |","|"+head.map(()=>"---").join("|")+"|"];
  rows.forEach(r=>out.push("| "+r.map(mdCell).join(" | ")+" |"));
  return out.join("\n");
}
function toMarkdown(cv, v){
  const L=[];
  L.push("# PERFORMANCE ARCHITECTURE CANVAS — "+(cv.name||"(chưa đặt tên)"));
  L.push("");
  L.push("**Canvas Stage:** "+v.stage+" · **Build Mode:** "+v.mode+" · **Schema Version:** 3.0 · **Last Updated:** "+
         (v.date||"")+" · **Migration Status:** Native v3");
  if(v.owner && v.owner!=="(chưa điền)") L.push("**Người lập:** "+v.owner);
  L.push("");
  L.push("## 1. GOAL | MỤC TIÊU"); L.push("");
  L.push(v.goal||"(chưa điền)");
  if(v.context){ L.push(""); L.push("**Bối cảnh & phạm vi:** "+v.context); }
  L.push("");
  L.push("## 2. KEY RESULT + CRITICAL OUTPUTS / CS"); L.push("");
  L.push(mdTable(["Thành phần","Loại","Hiện tại","Mục tiêu","Thời hạn","Tiêu chuẩn chất lượng (CS)"],
    [[v.kr.metric,"Key Result",v.kr.cur,v.kr.tgt,v.kr.due,v.kr.cs]].concat(
     (v.outputs||[]).map(o=>[o.name,"Critical Output",o.cur,o.tgt,o.due,o.cs]))));
  L.push("");
  L.push("## 3. SOLUTION DIRECTION + LEVER BEHAVIORS"); L.push("");
  L.push("**Solution Direction:** "+(v.direction||"(chưa điền)"));
  if(v.logic){ L.push(""); L.push("**Logic chốt hướng (kiểm chứng bằng bằng chứng):** "+v.logic); }
  L.push("");
  L.push(mdTable(["Chủ thể","Lever Behavior","Bối cảnh","Output tác động","Dấu hiệu quan sát được","Tần suất"],
    (v.behaviors||[]).map(b=>[b.actor,b.beh,b.ctx,b.out,b.sign,b.freq])));
  L.push("");
  L.push("## 4. CONDITIONS | 6 BOXES"); L.push("");
  L.push(mdTable(["6 Boxes","Điều kiện cần","Hiện trạng / Bằng chứng","Khoảng cách","Ưu tiên","Hành vi liên quan","Hành động sơ bộ","Người sở hữu"],
    (v.boxes||[]).map((b,i)=>[BOXES_FULL[i],b.cond,b.ev,b.gap,b.pri,b.beh,b.act,b.own])));
  L.push("");
  L.push("## 5. ACTION EXPERIMENT"); L.push("");
  L.push(mdTable(["Action","Start","Deadline","Owner","Supporter","Success Criteria","Status","Risk / Adjustment"],
    (v.actions||[]).map(a=>[a.act,a.start,a.due,a.own,a.sup,a.cri,a.st,a.risk])));
  if((v.risks||[]).length){
    L.push(""); L.push("**Rủi ro / Giả định cần kiểm chứng:**"); L.push("");
    v.risks.forEach(r=>L.push("- "+r));
  }
  L.push("");
  L.push("## 6. FOLLOW-UP EVIDENCE APPROPRIATE TO STAGE"); L.push("");
  L.push("### Measurement Plan"); L.push("");
  L.push(mdTable(["planned_date","evidence_layer","metric_or_criterion","baseline","target","data_source","collector","verifier"],
    (v.plan||[]).map(p=>[p.date,p.layer,p.metric,p.base,p.tgt,p.src,p.col,p.ver])));
  L.push("");
  L.push("### Observed Evidence"); L.push("");
  const obs = (v.stage==="DRAFT" || !(v.observed||[]).length)
    ? [Array(8).fill("TBD")]
    : v.observed.map(o=>[o.date,o.layer,o.val,o.src,o.conf,o.learn,o.dec,o.ver]);
  L.push(mdTable(["observed_date","evidence_layer","value_or_evidence","source_reference","confidence","learning","decision","verifier"], obs));
  L.push("");
  L.push("### Lịch Review & bài học"); L.push("");
  L.push(mdTable(["Mốc Review","Ngày","Behavior Evidence","Output Evidence","Result Evidence","Điều hiệu quả","Điều chưa hiệu quả","Learning & Next Step","Người xác nhận"],
    (v.reviews||[]).map(r=>[r.cp,r.date,r.be||"TBD",r.oe||"TBD",r.re||"TBD",r.ok||"TBD",r.no||"TBD",r.ln||"TBD",r.ver])));
  L.push("");
  return L.join("\n");
}

/* ================= XLSX (zip STORE + inline strings) ================= */
const CRC_TABLE=(()=>{const t=new Uint32Array(256);
  for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c}return t})();
function crc32(buf){let c=0xFFFFFFFF; for(let i=0;i<buf.length;i++)c=CRC_TABLE[(c^buf[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0}
function u16(v){return [v&255,(v>>8)&255]}
function u32(v){return [v&255,(v>>8)&255,(v>>16)&255,(v>>24)&255]}
function zipStore(files){
  const enc=new TextEncoder(), chunks=[], central=[]; let offset=0;
  const dosTime=u16(0), dosDate=u16(((2026-1980)<<9)|(8<<5)|13);
  files.forEach(f=>{
    const name=enc.encode(f.name), data=(typeof f.data==="string")?enc.encode(f.data):f.data;
    const crc=crc32(data);
    const head=[80,75,3,4,...u16(20),...u16(0x0800),...u16(0),...dosTime,...dosDate,
      ...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),...u16(0)];
    chunks.push(new Uint8Array(head), name, data);
    central.push({name,crc,size:data.length,offset});
    offset+=head.length+name.length+data.length;
  });
  let cdSize=0; const cdStart=offset;
  central.forEach(e=>{
    const rec=[80,75,1,2,...u16(20),...u16(20),...u16(0x0800),...u16(0),...dosTime,...dosDate,
      ...u32(e.crc),...u32(e.size),...u32(e.size),...u16(e.name.length),...u16(0),...u16(0),
      ...u16(0),...u16(0),...u32(0),...u32(e.offset)];
    chunks.push(new Uint8Array(rec), e.name);
    cdSize+=rec.length+e.name.length;
  });
  chunks.push(new Uint8Array([80,75,5,6,...u16(0),...u16(0),...u16(central.length),...u16(central.length),
    ...u32(cdSize),...u32(cdStart),...u16(0)]));
  return new Blob(chunks,{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
function xEsc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,"")}
function colName(n){let s="";while(n>0){const r=(n-1)%26;s=String.fromCharCode(65+r)+s;n=(n-r-1)/26}return s}
function sheetXML(rows){
  let out='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>';
  for(let c=1;c<=12;c++) out+='<col min="'+c+'" max="'+c+'" width="26" customWidth="1"/>';
  out+='</cols><sheetData>';
  rows.forEach((cells,ri)=>{
    if(!cells) return;
    out+='<row r="'+(ri+1)+'">';
    cells.forEach((cell,ci)=>{
      if(cell==null) return;
      const v=typeof cell==="object"?cell.v:cell;
      const s=typeof cell==="object"?(cell.s||1):1;
      if(String(v)==="") return;
      out+='<c r="'+colName(ci+1)+(ri+1)+'" s="'+s+'" t="inlineStr"><is><t xml:space="preserve">'+xEsc(v)+'</t></is></c>';
    });
    out+='</row>';
  });
  return out+'</sheetData></worksheet>';
}
const STYLES_XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+
'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
'<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'+
'<font><b/><sz val="11"/><name val="Calibri"/></font>'+
'<font><b/><sz val="11"/><color rgb="FFE7D0A2"/><name val="Calibri"/></font></fonts>'+
'<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'+
'<fill><patternFill patternType="solid"><fgColor rgb="FF0D1B2A"/><bgColor indexed="64"/></patternFill></fill></fills>'+
'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'+
'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
'<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'+
'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'+
'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'+
'<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'+
'</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
const H=v=>({v,s:3}), B=v=>({v,s:2});

function xlsxRows(cv, v){
  const rows=[], push=(...c)=>rows.push(c.length?c:null);
  push(B("Canvas Stage"), v.stage);
  push(B("Build Mode"), v.mode);
  push(B("Schema Version"), "3.0");
  push(B("Last Updated"), v.date);
  push(B("Migration Status"), "Native v3");
  push();
  push(B("PERFORMANCE ARCHITECTURE CANVAS — "+cv.name));
  if(v.owner && v.owner!=="(chưa điền)") push(B("Người lập"), v.owner);
  push();
  push(B("1. GOAL | MỤC TIÊU"));
  push(v.goal);
  if(v.context) push("Bối cảnh & phạm vi: "+v.context);
  push();
  push(B("2. KEY RESULT + CRITICAL OUTPUTS / CS"));
  push(H("Thành phần"),H("Loại"),H("Hiện tại"),H("Mục tiêu"),H("Thời hạn"),H("Tiêu chuẩn chất lượng (CS)"));
  push(v.kr.metric,"Key Result",v.kr.cur,v.kr.tgt,v.kr.due,v.kr.cs);
  (v.outputs||[]).forEach(o=>push(o.name,"Critical Output",o.cur,o.tgt,o.due,o.cs));
  push();
  push(B("3. SOLUTION DIRECTION + LEVER BEHAVIORS"));
  push("Solution Direction: "+v.direction);
  if(v.logic) push("Logic chốt hướng: "+v.logic);
  push(H("Chủ thể"),H("Lever Behavior"),H("Bối cảnh"),H("Output tác động"),H("Dấu hiệu quan sát được"),H("Tần suất"));
  (v.behaviors||[]).forEach(b=>push(b.actor,b.beh,b.ctx,b.out,b.sign,b.freq));
  push();
  push(B("4. CONDITIONS | 6 BOXES"));
  push(H("6 Boxes"),H("Điều kiện cần"),H("Hiện trạng / Bằng chứng"),H("Khoảng cách"),H("Ưu tiên"),H("Hành vi liên quan"),H("Hành động sơ bộ"),H("Người sở hữu"));
  (v.boxes||[]).forEach((b,i)=>push(BOXES_FULL[i],b.cond,b.ev,b.gap,b.pri,b.beh,b.act,b.own));
  push();
  push(B("5. ACTION EXPERIMENT"));
  push(H("Action"),H("Start"),H("Deadline"),H("Owner"),H("Supporter"),H("Success Criteria"),H("Status"),H("Risk / Adjustment"));
  (v.actions||[]).forEach(a=>push(a.act,a.start,a.due,a.own,a.sup,a.cri,a.st,a.risk));
  (v.risks||[]).forEach(r=>push("Rủi ro / Giả định: "+r));
  push();
  push(B("6. FOLLOW-UP EVIDENCE APPROPRIATE TO STAGE"));
  push(B("Measurement Plan"));
  push(H("planned_date"),H("evidence_layer"),H("metric_or_criterion"),H("baseline"),H("target"),H("data_source"),H("collector"),H("verifier"));
  (v.plan||[]).forEach(p=>push(p.date,p.layer,p.metric,p.base,p.tgt,p.src,p.col,p.ver));
  push();
  push(B("Observed Evidence"));
  push(H("observed_date"),H("evidence_layer"),H("value_or_evidence"),H("source_reference"),H("confidence"),H("learning"),H("decision"),H("verifier"));
  if(v.stage==="DRAFT" || !(v.observed||[]).length) push("TBD","TBD","TBD","TBD","TBD","TBD","TBD","TBD");
  else v.observed.forEach(o=>push(o.date,o.layer,o.val,o.src,o.conf,o.learn,o.dec,o.ver));
  push();
  push(B("Lịch Review & bài học"));
  push(H("Mốc Review"),H("Ngày"),H("Behavior Evidence"),H("Output Evidence"),H("Result Evidence"),H("Điều hiệu quả"),H("Điều chưa hiệu quả"),H("Learning & Next Step"),H("Người xác nhận"));
  (v.reviews||[]).forEach(r=>push(r.cp,r.date,r.be||"TBD",r.oe||"TBD",r.re||"TBD",r.ok||"TBD",r.no||"TBD",r.ln||"TBD",r.ver));
  return rows;
}
function buildXlsx(cv, v){
  return zipStore([
   {name:"[Content_Types].xml", data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
    '<Default Extension="xml" ContentType="application/xml"/>'+
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'+
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'},
   {name:"_rels/.rels", data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
   {name:"xl/workbook.xml", data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'+
    '<sheets><sheet name="Canvas" sheetId="1" r:id="rId1"/></sheets></workbook>'},
   {name:"xl/_rels/workbook.xml.rels", data:'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'+
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'},
   {name:"xl/styles.xml", data:STYLES_XML},
   {name:"xl/worksheets/sheet1.xml", data:sheetXML(xlsxRows(cv,v))}
  ]);
}

/* ================= Tải xuống / sao chép ================= */
function slugify(s){
  return String(s||"canvas").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"")
    .replace(/đ/g,"d").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"canvas";
}
function fileBase(cv, v){ return "canvas-"+slugify(cv.name)+"-"+String(v.date||"").replace(/-/g,""); }
function download(blob, filename){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download=filename;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href); a.remove()},2000);
}
function downloadXlsx(cv, v){ download(buildXlsx(cv,v), fileBase(cv,v)+".xlsx"); }
function downloadMd(cv, v){ download(new Blob([toMarkdown(cv,v)],{type:"text/markdown;charset=utf-8"}), fileBase(cv,v)+".md"); }
async function copyMd(cv, v, btn){
  const md=toMarkdown(cv,v);
  try{
    await navigator.clipboard.writeText(md);
    if(btn){ const t=btn.textContent; btn.textContent="✓ Đã sao chép — dán vào trợ lý AI"; setTimeout(()=>btn.textContent=t,2600); }
    return true;
  }catch(e){
    downloadMd(cv,v);
    if(btn){ const t=btn.textContent; btn.textContent="Đã tải file .md thay cho sao chép"; setTimeout(()=>btn.textContent=t,2600); }
    return false;
  }
}
