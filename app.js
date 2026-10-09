(() => {
  "use strict";

  const STORAGE_KEY = "thu-vien-hoi-dap.web.readonly.v2";
  const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets/";
  const SYNC_TAB = "_SyncLog";
  const config = window.THU_VIEN_CONFIG || {};
  const state = {
    records: [],
    selectedEntityId: null,
    query: "",
    token: null,
    tokenClient: null,
    syncing: false,
    remoteTitle: "",
    lastUpdated: null
  };

  const $ = id => document.getElementById(id);
  const el = {
    count: $("count-label"),
    status: $("sync-status"),
    connect: $("connect-button"),
    sync: $("sync-button"),
    query: $("search-input"),
    clear: $("clear-search"),
    results: $("question-list"),
    resultCount: $("result-count"),
    empty: $("empty-state"),
    emptyTitle: $("empty-title"),
    emptyMessage: $("empty-message"),
    answerEmpty: $("answer-empty"),
    answerCard: $("answer-card"),
    question: $("selected-question"),
    answer: $("selected-answer"),
    keywordsRow: $("keywords-row"),
    keywords: $("selected-keywords"),
    meta: $("record-meta"),
    copy: $("copy-button"),
    toast: $("toast")
  };

  function readState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      state.records = Array.isArray(saved.records) ? saved.records : [];
      state.selectedEntityId = typeof saved.selectedEntityId === "string" ? saved.selectedEntityId : null;
      state.lastUpdated = saved.lastUpdated || null;
    } catch (error) {
      throw new Error("Không đọc được dữ liệu đã lưu trên thiết bị: " + error.message);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      records: state.records,
      selectedEntityId: state.selectedEntityId,
      lastUpdated: state.lastUpdated
    }));
  }

  function activeRecords(records = state.records) {
    const latest = new Map();
    for (const record of records) {
      const previous = latest.get(record.entityId);
      if (!previous || compareRevision(record, previous) > 0) latest.set(record.entityId, record);
    }
    const active = [...latest.values()].filter(record => !record.isDeleted);
    const byQuestion = new Map();
    for (const record of active) {
      const previous = byQuestion.get(record.questionKey);
      if (!previous || compareRevision(record, previous) > 0) byQuestion.set(record.questionKey, record);
    }
    return [...byQuestion.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entityId.localeCompare(b.entityId));
  }

  function compareRevision(a, b) {
    const dateOrder = String(a.changedAt).localeCompare(String(b.changedAt));
    return dateOrder || String(a.changeId).localeCompare(String(b.changeId));
  }

  function cleanQuestion(value) {
    return String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
  }

  function questionKey(value) {
    return cleanQuestion(value).toLocaleLowerCase("vi")
      .replace(/[?.!:;,…？。 ]+$/u, "").trim();
  }

  function fold(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d").toLocaleLowerCase("vi").normalize("NFC");
  }

  function words(value) {
    return fold(value).match(/[\p{L}\p{N}]+/gu) || [];
  }

  function matchQuality(text, token) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...text.matchAll(new RegExp(escaped, "gu"))];
    let best = 0;
    for (const match of matches) {
      const index = match.index;
      const startsWord = index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1]);
      const end = index + token.length;
      const endsWord = end >= text.length || !/[\p{L}\p{N}]/u.test(text[end]);
      best = Math.max(best, startsWord ? (endsWord ? 10 : 6) : 1);
      if (best === 10) break;
    }
    return best;
  }

  function searchItems() {
    const items = activeRecords();
    const tokens = [...new Set(words(state.query))].slice(0, 12);
    if (!tokens.length) return items.map(item => ({ item, score: 0 }));
    const phrase = words(state.query).join(" ");
    return items.map(item => {
      const question = fold(item.question);
      const keyword = fold(item.keywords);
      let score = 0;
      for (const token of tokens) {
        const quality = matchQuality(question, token);
        if (quality) score += 10 + quality;
        else {
          const keywordQuality = matchQuality(keyword, token);
          if (!keywordQuality) return null;
          score += 8 + keywordQuality;
        }
      }
      const compact = " " + words(item.question).join(" ") + " ";
      if (tokens.length > 1 && compact.includes(" " + phrase + " ")) score += compact.indexOf(" " + phrase + " ") === 0 ? 40 : 25;
      else if (tokens.length === 1 && compact.startsWith(" " + tokens[0])) score += 15;
      return { item, score };
    }).filter(Boolean).sort((a, b) =>
      b.score - a.score || a.item.question.length - b.item.question.length || a.item.entityId.localeCompare(b.item.entityId)
    );
  }

  function escapeText(value) {
    return String(value || "");
  }

  function render() {
    const items = activeRecords();
    const hits = searchItems();
    const refreshedAt = state.lastUpdated ? ` · Cập nhật ${new Intl.DateTimeFormat("vi-VN", {
      hour: "2-digit", minute: "2-digit"
    }).format(new Date(state.lastUpdated))}` : "";
    el.count.textContent = `${items.length} câu hỏi${refreshedAt}`;
    el.results.replaceChildren();
    for (const { item } of hits) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "question-item" + (item.entityId === state.selectedEntityId ? " selected" : "");
      button.setAttribute("role", "listitem");
      const title = document.createElement("span");
      title.className = "question-title";
      title.textContent = escapeText(item.question);
      const preview = document.createElement("span");
      preview.className = "question-preview";
      preview.textContent = escapeText(item.answer.replace(/\s+/gu, " ").trim());
      button.append(title, preview);
      button.addEventListener("click", () => {
        state.selectedEntityId = item.entityId;
        saveState();
        render();
      });
      el.results.append(button);
    }
    el.empty.hidden = hits.length > 0;
    el.emptyTitle.textContent = items.length ? "Không tìm thấy câu phù hợp" : "Chưa có câu hỏi nào";
    el.emptyMessage.textContent = items.length
      ? "Thử từ khóa ngắn hơn hoặc gõ không dấu."
      : "Kết nối Google Sheets để tải kho dữ liệu dùng chung.";
    el.resultCount.textContent = state.query
      ? `${hits.length} kết quả`
      : "Chọn một câu hỏi để xem đáp án";
    el.clear.hidden = !state.query;
    const selected = items.find(item => item.entityId === state.selectedEntityId);
    el.answerEmpty.hidden = !!selected;
    el.answerCard.hidden = !selected;
    if (selected) {
      el.question.textContent = escapeText(selected.question);
      el.answer.textContent = escapeText(selected.answer);
      el.keywordsRow.hidden = !selected.keywords;
      el.keywords.textContent = escapeText(selected.keywords);
      el.meta.textContent = `Thêm bởi ${selected.createdBy || "không rõ"} · ${displayDate(selected.createdAt)}` +
        (selected.updatedAt ? ` · Sửa lần cuối ${displayDate(selected.updatedAt)}` : "");
    }
  }

  function displayDate(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "short", timeStyle: "short"
    }).format(date);
  }

  function setStatus(text, mode = "") {
    el.status.textContent = text;
    el.status.dataset.mode = mode;
  }

  let toastTimer = 0;
  function toast(text, error = false) {
    el.toast.textContent = text;
    el.toast.dataset.mode = error ? "error" : "";
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
  }

  function requestAccessToken(interactive) {
    return new Promise((resolve, reject) => {
      if (!window.google?.accounts?.oauth2) {
        reject(new Error("Không tải được dịch vụ đăng nhập Google. Kiểm tra kết nối Internet rồi tải lại trang."));
        return;
      }
      const clientId = String(config.googleClientId || "");
      if (!clientId || clientId.startsWith("SET_")) {
        reject(new Error("Chưa cấu hình OAuth Web. Hãy điền googleClientId trong web/config.js."));
        return;
      }
      state.tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
        callback: response => {
          if (response.error) {
            reject(new Error(response.error_description || response.error));
            return;
          }
          state.token = response.access_token;
          el.sync.disabled = false;
          el.connect.textContent = "Đã kết nối Google";
          setStatus("Đã đăng nhập Google · chưa đồng bộ", "connected");
          resolve(state.token);
        },
        error_callback: error => reject(new Error(error.message || "Đăng nhập Google bị đóng hoặc không thành công."))
      });
      state.tokenClient.requestAccessToken({ prompt: interactive ? "consent select_account" : "" });
    });
  }

  async function sheetsRequest(path) {
    if (!state.token) throw new Error("Phiên Google đã hết hạn. Hãy kết nối Google lại.");
    const response = await fetch(SHEETS_API + encodeURIComponent(config.spreadsheetId) + path, {
      headers: { Authorization: `Bearer ${state.token}` }
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* handled as an API error below */ }
    if (!response.ok) {
      const message = data?.error?.message || `Google Sheets API trả về lỗi ${response.status}.`;
      if (response.status === 401) {
        state.token = null;
        el.sync.disabled = true;
        el.connect.textContent = "Kết nối Google";
        throw new Error("Phiên Google đã hết hạn. Hãy kết nối Google lại.");
      }
      throw new Error(message);
    }
    return data;
  }

  function encodedRange(title, range) {
    return encodeURIComponent(`'${String(title).replaceAll("'", "''")}'!${range}`).replaceAll("%21", "!");
  }

  async function getSheets() {
    const data = await sheetsRequest("?fields=sheets(properties(sheetId,title,hidden))");
    return (data.sheets || []).map(sheet => sheet.properties);
  }

  async function readRows(title, range) {
    const data = await sheetsRequest(`/values/${encodedRange(title, range)}?valueRenderOption=FORMATTED_VALUE`);
    return data.values || [];
  }

  function fromSheetRow(row) {
    const value = index => String(row[index] ?? "");
    const changedAt = parseDate(value(1));
    const createdAt = parseDate(value(8)) || changedAt;
    if (!changedAt || !createdAt) return null;
    return {
      entityId: value(0),
      changedAt,
      changeId: value(2),
      isDeleted: value(3) === "1" || value(3).toUpperCase() === "TRUE",
      question: value(4),
      questionKey: value(5) || questionKey(value(4)),
      answer: value(6),
      keywords: value(7),
      createdAt,
      createdBy: value(9),
      updatedAt: parseDate(value(10)),
      updatedBy: value(11) || null
    };
  }

  function parseDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    const vi = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (!vi) return null;
    return new Date(Number(vi[3]), Number(vi[2]) - 1, Number(vi[1]), Number(vi[4] || 0), Number(vi[5] || 0)).toISOString();
  }

  async function readInitialRecords(title) {
    const rows = await readRows(title, "A1:Z");
    if (rows.length < 2) return [];
    const headers = rows.slice(0, 5).find(row => row.some(cell => String(cell).trim())) || rows[0];
    const normalized = headers.map(value => fold(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim());
    const find = prefix => normalized.findIndex(value => value.startsWith(prefix));
    let qIndex = find("cau hoi");
    let aIndex = find("dap an");
    if (aIndex < 0) aIndex = find("tra loi");
    if (qIndex < 0 || aIndex < 0) return [];
    const kIndex = find("tu khoa");
    const createdIndex = find("ngay them");
    const creatorIndex = find("nguoi them");
    const updatedIndex = find("ngay sua");
    const updaterIndex = find("nguoi sua");
    const result = [];
    for (let i = headers === rows[0] ? 1 : rows.indexOf(headers) + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const question = cleanQuestion(row[qIndex] || "");
      const answer = String(row[aIndex] || "").trim();
      const key = questionKey(question);
      if (!key || !answer) continue;
      const createdAt = parseDate(row[createdIndex] || "") || new Date().toISOString();
      const updatedAt = parseDate(row[updatedIndex] || "");
      const entityId = "legacy-" + await sha256(key);
      result.push({
        entityId,
        changedAt: updatedAt || createdAt,
        changeId: "sheet-baseline-" + entityId,
        isDeleted: false,
        question,
        questionKey: key,
        answer,
        keywords: String(row[kIndex] || ""),
        createdAt,
        createdBy: String(row[creatorIndex] || ""),
        updatedAt,
        updatedBy: String(row[updaterIndex] || "") || null
      });
    }
    return result;
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function mergeLatest(records) {
    const latest = new Map();
    for (const record of records) {
      if (!record.entityId || !record.changeId) continue;
      const previous = latest.get(record.entityId);
      if (!previous || compareRevision(record, previous) > 0) latest.set(record.entityId, record);
    }
    return [...latest.values()];
  }

  async function syncNow() {
    if (state.syncing) return;
    if (!state.token) {
      try { await requestAccessToken(true); }
      catch (error) { setStatus("Google chưa kết nối", "error"); toast(error.message, true); return; }
    }
    state.syncing = true;
    el.sync.disabled = true;
    el.connect.disabled = true;
    setStatus("Đang tải dữ liệu từ Google Sheets…");
    try {
      const sheets = await getSheets();
      state.remoteTitle = sheets.find(sheet => sheet.sheetId === 0)?.title || sheets[0]?.title;
      if (!state.remoteTitle) throw new Error("Google Sheets chưa có trang tính nào.");
      const syncTab = sheets.find(sheet => sheet.title === SYNC_TAB);
      const syncRows = syncTab ? await readRows(SYNC_TAB, "A2:L") : [];
      const remote = syncRows.map(fromSheetRow).filter(Boolean);
      state.records = remote.length ? mergeLatest(remote) : await readInitialRecords(state.remoteTitle);
      if (!state.records.some(record => record.entityId === state.selectedEntityId)) state.selectedEntityId = null;
      state.lastUpdated = new Date().toISOString();
      saveState();
      render();
      setStatus(`Tải xong lúc ${new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`, "connected");
      toast(`Đã tải ${activeRecords().length} câu hỏi từ Google Sheets.`);
    } catch (error) {
      setStatus("Đồng bộ chưa thành công", "error");
      toast(error.message || "Không thể đồng bộ Google Sheets.", true);
    } finally {
      state.syncing = false;
      el.sync.disabled = !state.token;
      el.connect.disabled = false;
    }
  }

  async function copyAnswer() {
    const item = activeRecords().find(record => record.entityId === state.selectedEntityId);
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.answer);
    } catch {
      const area = document.createElement("textarea");
      area.value = item.answer;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      if (!copied) {
        toast("Trình duyệt không cho phép sao chép. Hãy chọn và sao chép đáp án thủ công.", true);
        return;
      }
    }
    toast("Đã sao chép đáp án.");
  }

  function connect() {
    requestAccessToken(true).then(() => toast("Đã kết nối Google với quyền chỉ đọc. Bấm “Cập nhật kho” để tải dữ liệu."))
      .catch(error => {
        setStatus("Google chưa kết nối", "error");
        toast(error.message, true);
      });
  }

  el.query.addEventListener("input", () => {
    state.query = el.query.value;
    render();
  });
  el.clear.addEventListener("click", () => {
    el.query.value = "";
    state.query = "";
    render();
    el.query.focus();
  });
  el.connect.addEventListener("click", connect);
  el.sync.addEventListener("click", syncNow);
  el.copy.addEventListener("click", copyAnswer);

  try {
    readState();
    render();
    if (!config.googleClientId || String(config.googleClientId).startsWith("SET_")) {
      setStatus("Cần cấu hình OAuth Web", "error");
    }
  } catch (error) {
    setStatus("Không đọc được dữ liệu", "error");
    toast(error.message, true);
  }

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.error("Không thể cài bộ nhớ đệm offline:", error);
    });
  }
})();
