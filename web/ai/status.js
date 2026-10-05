/**
 * web/ai/status.js — AI availability + friendly error copy shared by every
 * AI surface (canvas AI panel, coaching grader). Spec §7.1: when AI is not
 * configured or switched off, the UI must say so BEFORE the user consents
 * and runs — not after a failed run with a raw machine code.
 *
 * - fetchAiStatus() reads GET /ai/status (any signed-in user; exactly
 *   {configured, enabled} — no endpoint/model/key detail). A failed read
 *   resolves null: the surface stays usable and the run path still maps
 *   the server's error code.
 * - friendlyError()/readFriendlyError() turn stable server codes into
 *   Vietnamese guidance; the code and request id stay as a small suffix
 *   for support, never a provider detail.
 */
import { apiFetch } from "../api.js";

/** Stable server codes → what the user can actually do about it. */
export const ERROR_MESSAGES = {
  AI_NOT_CONFIGURED:
    "AI nội bộ chưa được cấu hình — liên hệ owner/admin để thiết lập endpoint và key trong trang Quản trị.",
  AI_DISABLED:
    "AI nội bộ đang tắt — owner/admin có thể bật lại trong trang Quản trị.",
  AI_KEY_DECRYPT_FAILED:
    "Không đọc được key AI đã lưu — owner/admin cần nhập lại key trong trang Quản trị.",
  AI_AUTH_FAILED:
    "Endpoint AI từ chối key đã cấu hình — owner/admin cần kiểm tra lại key.",
  AI_DESTINATION_DENIED:
    "Endpoint AI nằm ngoài danh sách được phép — báo admin kiểm tra cấu hình.",
  AI_REDIRECT_DENIED:
    "Endpoint AI chuyển hướng sang địa chỉ không được phép — báo admin kiểm tra cấu hình.",
  AI_HTTP_NOT_ALLOWED:
    "Endpoint AI dùng HTTP không mã hóa nhưng máy chủ chưa cho phép — báo admin.",
  AI_CONSENT_REQUIRED:
    "Cần đánh dấu đồng ý xử lý nội dung bằng AI nội bộ trước khi chạy.",
  AI_BUSY:
    "Công ty đang có 2 lượt AI chạy đồng thời (giới hạn) — thử lại sau ít phút.",
  AI_PREVIEW_BUSY:
    "Bộ nhớ xem trước AI đang đầy — thử lại sau ít phút.",
  AI_IDEMPOTENCY_CONFLICT:
    "Yêu cầu bị trùng mã với một lượt chạy khác — tải lại trang rồi chạy lại.",
  AI_TIMEOUT:
    "AI nội bộ phản hồi quá thời gian cho phép — có thể thử lại.",
  AI_UNAVAILABLE:
    "Không kết nối được AI nội bộ (endpoint không phản hồi) — thử lại sau hoặc báo admin.",
  AI_BAD_RESPONSE:
    "AI nội bộ trả về phản hồi không đọc được — thử lại; nếu lặp lại hãy báo admin.",
  AI_INPUT_TOO_LARGE:
    "Nội dung gửi AI vượt giới hạn — rút gọn ghi chú/transcript rồi thử lại.",
  AI_OUTPUT_TOO_LARGE:
    "Kết quả AI vượt giới hạn độ dài — rút gọn đầu vào rồi thử lại.",
  PREVIEW_TOO_LARGE:
    "Kết quả xem trước quá lớn — rút gọn đầu vào rồi thử lại.",
  PREVIEW_EXPIRED:
    "Bản xem trước đã hết hạn (sau 15 phút hoặc máy chủ khởi động lại) — chạy lại.",
  AI_CANCELLED: "Lượt chạy đã bị hủy — không có kết quả nào được lưu.",
  AI_RUN_FINISHED: "Lượt chạy đã kết thúc.",
  AI_RUN_NOT_READY: "Lượt chạy chưa xong — đợi hoàn thành rồi áp dụng.",
  AI_BASE_CHANGED:
    "Bản nháp đã thay đổi kể từ lúc chạy AI — chạy lại để có đề xuất trên bản mới nhất.",
  AI_PROPOSAL_INVALID:
    "Đề xuất AI không hợp lệ nên không thể áp dụng — hãy chạy lại.",
  AI_WARNINGS_UNACCEPTED:
    "Cần đánh dấu xác nhận các cảnh báo trước khi áp dụng.",
  AI_RUN_MISMATCH:
    "Lượt chấm không thuộc phiên đang chọn — chạy lại grader cho phiên này.",
  AI_RUN_NOT_SUCCEEDED: "Lượt chấm chưa thành công — không có gì để lưu.",
  ORACLE_REPORT_INVALID:
    "Báo cáo ORACLE không hợp lệ nên không thể lưu — hãy chạy lại.",
  REPORT_BRIDGE_EMPTY:
    "Các mục đã chọn trong báo cáo không có nội dung — chọn mục khác.",
  REPORT_BRIDGE_INVALID: "Báo cáo này không dùng được làm đầu vào Renderer.",
  AI_INTERNAL:
    "Lỗi nội bộ khi chạy AI — thử lại; nếu lặp lại hãy báo admin kèm mã yêu cầu.",
  CANVAS_ARCHIVED:
    "Canvas đã lưu trữ — chỉ xem, không chỉnh sửa hay chạy AI được nữa.",
  DRAFT_CONFLICT: "Bản nháp đã thay đổi — tải lại trang trước khi tiếp tục.",
  USER_NOT_ACTIVE: "Người dùng được chọn không còn hoạt động.",
  NOT_FOUND:
    "Không tìm thấy mục này — hoặc bạn không có quyền với nó.",
  FORBIDDEN: "Bạn không có quyền thực hiện thao tác này.",
  INVALID_INPUT: "Dữ liệu chưa hợp lệ — kiểm tra lại rồi thử lại.",
  RATE_LIMITED: "Quá nhiều yêu cầu — đợi một chút rồi thử lại.",
};

const RUN_STATUS_LABEL = {
  queued: "đang chờ",
  running: "đang chạy",
  succeeded: "hoàn thành",
  failed: "lỗi",
  cancelled: "đã hủy",
  interrupted: "bị gián đoạn (máy chủ khởi động lại) — chạy lại",
};

/** Vietnamese label for an ai_run status (unknown values pass through). */
export function runStatusLabel(status) {
  return RUN_STATUS_LABEL[status] ?? String(status);
}

/** Friendly text for a code; unknown codes fall back to a generic line. */
export function friendlyError(code, fallback = "Không thực hiện được — thử lại sau.") {
  return (typeof code === "string" && ERROR_MESSAGES[code]) || fallback;
}

/**
 * Read an error Response into "friendly message (CODE · mã yêu cầu …)".
 * The suffix keeps the stable code + request id for support tickets.
 */
export async function readFriendlyError(res, fallback) {
  const data = await res.json().catch(() => null);
  const code = typeof data?.code === "string" ? data.code : null;
  const rid =
    typeof data?.request_id === "string"
      ? data.request_id
      : typeof data?.requestId === "string"
        ? data.requestId
        : null;
  const msg = friendlyError(
    code,
    fallback ?? `Không thực hiện được (HTTP ${res.status}) — thử lại sau.`,
  );
  const suffix = [code, rid ? `mã yêu cầu ${rid.slice(0, 8)}` : null]
    .filter(Boolean)
    .join(" · ");
  return { code, message: suffix ? `${msg} (${suffix})` : msg };
}

/** GET /ai/status → {configured, enabled} | null when unreadable. */
export async function fetchAiStatus() {
  try {
    const res = await apiFetch("/ai/status");
    if (!res.ok) return null;
    const s = await res.json();
    return {
      configured: s?.configured === true,
      enabled: s?.enabled === true,
    };
  } catch {
    return null;
  }
}

/**
 * The up-front notice for a status, or null when AI is usable (or the
 * status could not be read — the run path then reports precisely).
 */
export function aiUnavailableNotice(status) {
  if (!status) return null;
  if (!status.configured) return ERROR_MESSAGES.AI_NOT_CONFIGURED;
  if (!status.enabled) return ERROR_MESSAGES.AI_DISABLED;
  return null;
}

/**
 * Render/refresh the availability banner inside `host` (before `before`
 * when given) and report whether AI may run. The banner carries a "Kiểm
 * tra lại" button so a user whose admin just configured AI doesn't need a
 * reload; `onChange(available)` fires after every check.
 */
export function mountAiAvailability(host, { before = null, onChange } = {}) {
  const box = document.createElement("div");
  box.className = "stage-note ai-unavailable";
  box.dataset.testid = "ai-unavailable";
  box.setAttribute("role", "status");
  box.hidden = true;
  const text = document.createElement("span");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "add";
  retry.textContent = "Kiểm tra lại";
  retry.style.marginLeft = "10px";
  box.append(text, retry);
  if (before && before.parentNode === host) host.insertBefore(box, before);
  else host.prepend(box);

  let available = true;
  async function check() {
    retry.disabled = true;
    const notice = aiUnavailableNotice(await fetchAiStatus());
    retry.disabled = false;
    available = notice === null;
    text.textContent = notice ?? "";
    box.hidden = available;
    onChange?.(available);
    return available;
  }
  retry.addEventListener("click", () => void check());
  return { check, isAvailable: () => available, element: box };
}
