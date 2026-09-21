/**
 * web/coaching/sharing.js — per-version share controls (task 4.4, spec §6).
 *
 * Mounted only for a report manager (the session's coach of record or an
 * owner — the server re-checks regardless). Grants and revocations target
 * exactly this report row/version: a re-graded version starts with an
 * empty share set. The API exposes grant/revoke actions, not a share
 * roster — the card shows action results, and the durable record is the
 * audit trail.
 */
import { apiFetch } from "../api.js";

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function readError(res) {
  const data = await res.json().catch(() => null);
  const code = typeof data?.code === "string" ? data.code : "REQUEST_FAILED";
  const req =
    typeof data?.requestId === "string" ? ` · req ${data.requestId}` : "";
  return `${code}${req}`;
}

/**
 * @param host detail host — controls are appended into it
 * @param opts {report, users, onChanged}
 */
export function mountSharing(host, { report, users, onChanged }) {
  const wrap = el("div", "share-row no-print");
  const selWrap = el("div");
  const sel = document.createElement("select");
  sel.id = `shareTarget-${report.id}`;
  const selLabel = el("label", null, "Chia sẻ với người dùng");
  selLabel.setAttribute("for", sel.id);

  // Already-authorized users are pointless share targets (coach of record,
  // creator, owner all read via the base ACL). The COACHEE stays listed —
  // sharing the result with the person coached is the primary use case.
  const candidates = users.filter(
    (u) =>
      u.status === "active" &&
      u.id !== report.coachUserId &&
      u.id !== report.createdBy,
  );
  sel.replaceChildren(
    ...candidates.map((u) =>
      Object.assign(el("option"), {
        value: u.id,
        textContent: `${u.name} — ${u.email}`,
      }),
    ),
  );
  selWrap.append(selLabel, sel);

  const grantBtn = Object.assign(el("button", "act", "Chia sẻ"), {
    type: "button",
  });
  const revokeBtn = Object.assign(el("button", "act", "Thu hồi chia sẻ"), {
    type: "button",
  });
  const status = el("p", "note");
  status.dataset.testid = "share-status";
  status.setAttribute("role", "status");

  const intro = el(
    "p",
    "note",
    "Chia sẻ chỉ áp dụng cho phiên bản báo cáo này — người được chia sẻ đọc được nhưng không chia sẻ tiếp. " +
      "Thu hồi có hiệu lực ngay từ request tiếp theo.",
  );

  grantBtn.addEventListener("click", async () => {
    const userId = sel.value;
    if (!userId) return;
    status.textContent = "Đang chia sẻ…";
    const res = await apiFetch(`/reports/${report.id}/shares/${userId}`, {
      method: "PUT",
    });
    status.textContent = res.ok
      ? "Đã chia sẻ quyền đọc báo cáo này."
      : `Không chia sẻ được: ${await readError(res)}`;
    if (res.ok) onChanged?.();
  });

  revokeBtn.addEventListener("click", async () => {
    const userId = sel.value;
    if (!userId) return;
    status.textContent = "Đang thu hồi…";
    const res = await apiFetch(`/reports/${report.id}/shares/${userId}`, {
      method: "DELETE",
    });
    status.textContent =
      res.status === 204
        ? "Đã thu hồi — người đó không còn đọc được từ request tiếp theo."
        : res.status === 404
          ? "Không có chia sẻ nào đang hiệu lực cho người này."
          : `Không thu hồi được: ${await readError(res)}`;
    if (res.status === 204) onChanged?.();
  });

  wrap.append(selWrap, grantBtn, revokeBtn);
  host.append(el("h4", null, "Chia sẻ báo cáo"), intro, wrap, status);
}
