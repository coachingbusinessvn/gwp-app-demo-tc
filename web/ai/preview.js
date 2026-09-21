/**
 * web/ai/preview.js — render a staged AI run preview (task 3.6).
 *
 * Trust boundary: model output is rendered as TEXT only — every dynamic
 * string goes through textContent / DOM APIs, never innerHTML. An
 * invalid proposal renders as a plain-text diagnostic; nothing here can
 * turn generated content into markup.
 *
 * Renderer previews show the diff + issues; warnings must be ticked one
 * by one before "Áp dụng" enables — accepted ids go to the apply call.
 * Coach previews are read-only (criteria table + labelled advice) — the
 * coach never mutates the canvas, so no apply is rendered.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const DIFF_LABEL = {
  outputs: "Critical Outputs",
  behaviors: "Lever Behaviors",
  boxes: "6 Boxes",
  actions: "Action Experiments",
  plan: "Measurement Plan",
  observed: "Observed Evidence",
  reviews: "Review Schedule",
};
const META_LABEL = {
  meta: "Thông tin canvas",
  goal: "Goal",
  kr: "Key Result",
  solution: "Solution Direction",
  risks: "Risks & Safeguards",
};

function renderIssues(host, issues, accepted) {
  const list = el("ul", "ai-issues");
  for (const i of issues) {
    const li = el("li", `ai-issue ai-${i.severity}`);
    if (i.severity === "warning") {
      const label = el("label", "ai-warn");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.warnId = i.id;
      cb.addEventListener("change", () => {
        if (cb.checked) accepted.add(i.id);
        else accepted.delete(i.id);
        host.dispatchEvent(new CustomEvent("ai-warnings-changed"));
      });
      label.append(cb, document.createTextNode(` ${i.code} — ${i.message}`));
      li.append(label);
    } else {
      li.append(el("b", null, `${i.code} — `), document.createTextNode(i.message));
    }
    list.append(li);
  }
  return list;
}

/** Short readable rendering of a scalar proposal field for the diff. */
function scalarPreview(proposal, key) {
  const v = proposal?.[key];
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (key === "goal") return v.statement ?? "";
  if (key === "kr") {
    return [v.metric, v.current, v.target, v.deadline]
      .filter(Boolean)
      .join(" → ");
  }
  if (key === "solution") return v.direction ?? "";
  if (key === "risks") return String(v).slice(0, 200);
  if (key === "meta") {
    return [v.title, v.stage].filter(Boolean).join(" · ");
  }
  return "";
}

function renderDiffSummary(diff, proposal) {
  const box = el("div", "ai-diff");
  box.append(el("h4", null, "Khác biệt so với bản hiện tại"));
  const ul = el("ul");
  for (const s of diff.sections) {
    if (!s.added && !s.changed && !s.removed) continue;
    const parts = [];
    if (s.added) parts.push(`+${s.added} thêm`);
    if (s.changed) parts.push(`${s.changed} sửa`);
    if (s.removed) parts.push(`−${s.removed} xóa`);
    ul.append(
      el("li", null, `${DIFF_LABEL[s.name] ?? s.name}: ${parts.join(", ")}`),
    );
    // Row-level labels so the reviewer sees WHAT moved, not just counts.
    const changed = s.rows.filter((r) => r.kind !== "unchanged").slice(0, 12);
    if (changed.length) {
      const sub = el("ul", "ai-diff-rows");
      for (const r of changed) {
        const mark =
          r.kind === "added" ? "+" : r.kind === "removed" ? "−" : "±";
        sub.append(el("li", `ai-row-${r.kind}`, `${mark} ${r.label}`));
      }
      ul.append(sub);
    }
  }
  for (const k of diff.metaChanged) {
    const text = scalarPreview(proposal, k);
    ul.append(
      el(
        "li",
        null,
        `${META_LABEL[k] ?? k}: ${text ? `đề xuất “${text}”` : "nội dung thay đổi"}`,
      ),
    );
  }
  if (!ul.children.length) {
    ul.append(el("li", null, "Không có thay đổi nội dung."));
  }
  box.append(ul);
  return box;
}

function renderCoach(output) {
  const box = el("div", "ai-coach");
  box.append(
    el(
      "h4",
      null,
      `Điểm rubric v${output.rubricVersion}: ${output.total}/100`,
    ),
  );
  const tbl = el("table", "tbl ai-rubric");
  const head = el("tr");
  for (const h of ["Tiêu chí", "Điểm", "Bằng chứng"]) head.append(el("th", null, h));
  tbl.append(head);
  for (const c of output.criteria) {
    const tr = el("tr");
    tr.append(
      el("td", null, c.id),
      el("td", null, `${c.score}/${c.max}`),
      el("td", null, c.note || c.evidenceRefs.join(", ")),
    );
    tbl.append(tr);
  }
  box.append(tbl);
  if (output.advice.length) {
    box.append(el("h4", null, "Nhận xét"));
    const ul = el("ul", "ai-advice");
    for (const a of output.advice) {
      const conf = a.confidence ? ` · độ tin cậy ${a.confidence}` : "";
      ul.append(
        el("li", null, `[${a.kind}${conf}] ${a.text}`),
      );
    }
    box.append(ul);
  }
  return box;
}

/**
 * @param host    container (emptied first)
 * @param preview the staged preview {kind, …} plus its captured `base`
 * @param onApply async (acceptedWarnings: string[]) => void — renderer only
 */
export function renderAiPreview(host, preview, { onApply } = {}) {
  host.replaceChildren();
  host.dataset.testid = "ai-preview";

  const errors = (preview.issues ?? []).filter((i) => i.severity === "error");
  const warnings = (preview.issues ?? []).filter(
    (i) => i.severity === "warning",
  );

  if (preview.kind === "coach") {
    if (preview.output) host.append(renderCoach(preview.output));
    if (errors.length || warnings.length) {
      host.append(renderIssues(host, preview.issues, new Set()));
    }
    if (!preview.output && !errors.length) {
      host.append(el("p", "note", "Coach không tạo được kết quả."));
    }
    return;
  }

  // kind === "renderer"
  if (!preview.proposal) {
    host.append(el("h4", null, "Kết quả AI không tạo được đề xuất hợp lệ"));
    if (preview.issues?.length) {
      host.append(renderIssues(host, preview.issues, new Set()));
    }
    return;
  }

  if (preview.diff) {
    host.append(renderDiffSummary(preview.diff, preview.proposal));
  }

  const accepted = new Set();
  if (preview.issues?.length) {
    host.append(renderIssues(host, preview.issues, accepted));
  }

  if (errors.length === 0 && onApply) {
    const applyBtn = el("button", "add", "Áp dụng vào bản nháp");
    applyBtn.type = "button";
    applyBtn.id = "aiApply";
    const refresh = () => {
      applyBtn.disabled = accepted.size < warnings.length;
    };
    host.addEventListener("ai-warnings-changed", refresh);
    refresh();
    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      try {
        await onApply([...accepted]);
      } finally {
        applyBtn.disabled = false;
      }
    });
    host.append(applyBtn);
  }
}
