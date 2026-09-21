/* web/admin/ai.js — AI (BYOK) settings panel (task 3.6).
 *
 * Owner/admin only — the API enforces it; this module just renders.
 * The stored key is NEVER echoed: the key input starts empty with a
 * placeholder saying whether one is stored; typing a value replaces it,
 * leaving it empty preserves it, and "Xóa key" is the only way to clear.
 * All dynamic text goes through textContent — a malformed baseUrl or
 * model name can never become markup.
 */
import { el, field, miniButton, reqJson, showError } from "./http.js";

export function mountAi(panel) {
  if (!panel) return;

  const head = el("h2", null, "AI nội bộ (BYOK)");
  const note = el(
    "p",
    "note",
    "Endpoint chat-completions do công ty tự host. Key được mã hóa khi lưu và không bao giờ trả về giao diện — chỉ có thể thay thế hoặc xóa.",
  );
  const state = el("p", "note");
  state.id = "aiStateLine";

  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.id = "aiCfgEnabled";
  const enabledLabel = el("label");
  enabledLabel.setAttribute("for", "aiCfgEnabled");
  enabledLabel.append(
    enabled,
    document.createTextNode(" Bật AI nội bộ cho toàn công ty"),
  );

  const baseUrl = document.createElement("input");
  baseUrl.type = "url";
  baseUrl.placeholder = "https://llm.internal:8443/v1";
  const model = document.createElement("input");
  model.type = "text";
  model.placeholder = "vd: qwen3-32b-instruct";
  const timeout = document.createElement("input");
  timeout.type = "number";
  timeout.min = "5";
  timeout.max = "300";
  const maxTokens = document.createElement("input");
  maxTokens.type = "number";
  maxTokens.min = "256";
  maxTokens.max = "32768";
  const key = document.createElement("input");
  key.type = "password";
  key.autocomplete = "new-password";

  const status = el("p", "note");
  status.id = "aiCfgStatus";
  status.setAttribute("role", "status");
  const errBox = el("p", "note");
  errBox.hidden = true;
  errBox.setAttribute("role", "alert");

  const saveBtn = miniButton("Lưu cấu hình AI");
  saveBtn.id = "aiCfgSave";
  const testBtn = miniButton("Kiểm tra kết nối");
  testBtn.id = "aiCfgTest";
  const clearBtn = miniButton("Xóa key đã lưu");
  clearBtn.id = "aiCfgClear";
  const btnRow = el("div");
  btnRow.style.display = "flex";
  btnRow.style.gap = "8px";
  btnRow.style.marginTop = "12px";
  btnRow.append(saveBtn, testBtn, clearBtn);

  panel.append(
    head,
    note,
    state,
    enabledLabel,
    field("Endpoint baseUrl", baseUrl),
    field("Model", model),
    field("Timeout (giây)", timeout),
    field("Giới hạn token đầu ra", maxTokens),
    field("API key", key),
    btnRow,
    status,
    errBox,
  );

  async function load() {
    try {
      const s = await reqJson("GET", "/settings/ai");
      enabled.checked = !!s.enabled;
      baseUrl.value = s.baseUrl ?? "";
      model.value = s.model ?? "";
      timeout.value = String(s.timeoutSeconds ?? "");
      maxTokens.value = String(s.maxOutputTokens ?? "");
      key.value = ""; // the stored key is never echoed back
      key.placeholder = s.configured
        ? "••• đã lưu — để trống để giữ nguyên"
        : "Chưa có key — dán key mới để lưu";
      state.textContent = s.configured
        ? `Trạng thái: đã cấu hình (${s.enabled ? "đang bật" : "đang tắt"})`
        : "Trạng thái: chưa cấu hình.";
    } catch (err) {
      showError(errBox, err);
    }
  }

  saveBtn.addEventListener("click", async () => {
    errBox.hidden = true;
    status.textContent = "Đang lưu…";
    const body = {
      enabled: enabled.checked,
      baseUrl: baseUrl.value.trim(),
      model: model.value.trim(),
      timeoutSeconds: Number(timeout.value),
      maxOutputTokens: Number(maxTokens.value),
    };
    if (key.value !== "") body.apiKey = key.value; // empty = keep stored key
    try {
      await reqJson("PUT", "/settings/ai", body);
      status.textContent = "Đã lưu cấu hình AI.";
      key.value = "";
      await load();
    } catch (err) {
      status.textContent = "";
      showError(errBox, err);
    }
  });

  testBtn.addEventListener("click", async () => {
    errBox.hidden = true;
    status.textContent = "Đang kiểm tra kết nối…";
    try {
      const r = await reqJson("POST", "/settings/ai/test");
      status.textContent = `Kết nối OK — model ${r.model}, ${r.latencyMs}ms${r.streaming ? ", SSE streaming hoạt động" : " (không streaming)"}.`;
    } catch (err) {
      status.textContent = "";
      showError(errBox, err);
    }
  });

  clearBtn.addEventListener("click", async () => {
    errBox.hidden = true;
    try {
      await reqJson("DELETE", "/settings/ai/key");
      status.textContent = "Đã xóa key.";
      await load();
    } catch (err) {
      showError(errBox, err);
    }
  });

  void load();
}
