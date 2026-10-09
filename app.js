(() => {
  "use strict";

  const STORAGE_KEY = "thu-vien-hoi-dap.web.v1";
  const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets/";
  const SYNC_TAB = "_SyncLog";
  const SYNC_HEADERS = [
    "EntityId", "ChangedAt", "ChangeId", "IsDeleted", "Question", "QuestionKey",
    "Answer", "Keywords", "CreatedAt", "CreatedBy", "UpdatedAt", "UpdatedBy"
  ];
  const config = window.THU_VIEN_CONFIG || {};
  const state = {
    records: [],
    selectedEntityId: null,
    query: "",
    token: null,
    tokenClient: null,
    syncing: false,
    editingEntityId: null,
    userName: "Người dùng web",
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
    add: $("add-button"),
    edit: $("edit-button"),
    remove: $("delete-button"),
    editor: $("editor"),
    editorForm: $("editor-form"),
    editorTitle: $("editor-title"),
    questionField: $("question-field"),
    answerField: $("answer-field"),
    keywordsField: $("keywords-field"),
    editorError: $("editor-error"),
    closeEditor: $("close-editor"),
    cancelEditor: $("cancel-editor"),
    export: $("export-button"),
    importFile: $("import-file"),
    user: $("user-label"),
    toast: $("toast")
  };

  function readState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      state.records = Array.isArray(saved.records) ? saved.records : [];
      state.userName = typeof saved.userName === "string" ? saved.userName : state.userName;
      state.selectedEntityId = typeof saved.selectedEntityId === "string" ? saved.selectedEntityId : null;
      state.lastUpdated = saved.lastUpdated || null;
    } catch (error) {
      throw new Error("Không đọc được dữ liệu đã lưu trên thiết bị: " + error.message);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      records: state.records,
      userName: state.userName,
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
    el.count.textContent = `${items.length} câu hỏi`;
    el.user.textContent = state.userName;
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

  function newRevision(old, fields, isDeleted = false) {
    const now = new Date().toISOString();
    return {
      entityId: old ? old.entityId : crypto.randomUUID().replaceAll("-", ""),
      changedAt: now,
      changeId: crypto.randomUUID().replaceAll("-", ""),
      isDeleted,
      question: fields.question ?? old?.question ?? "",
      questionKey: fields.questionKey ?? old?.questionKey ?? "",
      answer: fields.answer ?? old?.answer ?? "",
      keywords: fields.keywords ?? old?.keywords ?? "",
      createdAt: old?.createdAt || now,
      createdBy: old?.createdBy || state.userName,
      updatedAt: old ? now : null,
      updatedBy: old ? state.userName : null
    };
  }

  function openEditor(item = null) {
    state.editingEntityId = item?.entityId || null;
    el.editorTitle.textContent = item ? "Sửa câu hỏi" : "Thêm câu hỏi";
    el.questionField.value = item?.question || "";
    el.answerField.value = item?.answer || "";
    el.keywordsField.value = item?.keywords || "";
    el.editorError.hidden = true;
    el.editor.hidden = false;
    el.questionField.focus();
  }

  function closeEditor() {
    el.editor.hidden = true;
    state.editingEntityId = null;
  }

  async function saveEditor(event) {
    event.preventDefault();
    const question = cleanQuestion(el.questionField.value);
    const answer = String(el.answerField.value || "").normalize("NFC").replace(/\r\n?/g, "\n").trim();
    const keywords = cleanQuestion(el.keywordsField.value);
    const key = questionKey(question);
    if (!key || !answer) {
      showEditorError("Vui lòng nhập đầy đủ câu hỏi và đáp án.");
      return;
    }
    const duplicate = activeRecords().find(item => item.questionKey === key && item.entityId !== state.editingEntityId);
    if (duplicate) {
      showEditorError("Câu hỏi này đã có trong kho. Hãy sửa câu hiện có để tránh tạo bản trùng.");
      return;
    }
    const old = state.records.filter(record => record.entityId === state.editingEntityId)
      .sort(compareRevision).at(-1) || null;
    const record = newRevision(old, { question, questionKey: key, answer, keywords });
    state.records.push(record);
    state.selectedEntityId = record.entityId;
    saveState();
    render();
    closeEditor();
    toast("Đã lưu trên thiết bị. Bấm “Đồng bộ” để cập nhật Google Sheets.");
  }

  function showEditorError(message) {
    el.editorError.textContent = message;
    el.editorError.hidden = false;
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
        scope: "https://www.googleapis.com/auth/spreadsheets",
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
      state.tokenClient.requestAccessToken({ prompt: interactive ? "select_account" : "" });
    });
  }

  async function sheetsRequest(path, options = {}) {
    if (!state.token) throw new Error("Phiên Google đã hết hạn. Hãy kết nối Google lại.");
    const response = await fetch(SHEETS_API + encodeURIComponent(config.spreadsheetId) + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${state.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
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

  async function ensureSyncTab(sheets) {
    if (sheets.some(sheet => sheet.title === SYNC_TAB)) return;
    await sheetsRequest(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SYNC_TAB, hidden: true } } }] })
    });
    await sheetsRequest(`/values/${encodedRange(SYNC_TAB, "A1:L1")}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ majorDimension: "ROWS", values: [SYNC_HEADERS] })
    });
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

  function toSheetRow(record) {
    return [
      record.entityId, record.changedAt, record.changeId, record.isDeleted ? "1" : "0",
      record.question, record.questionKey, record.answer, record.keywords, record.createdAt,
      record.createdBy, record.updatedAt || "", record.updatedBy || ""
    ];
  }

  async function appendRecords(records) {
    for (let offset = 0; offset < records.length; offset += 500) {
      await sheetsRequest(`/values/${encodedRange(SYNC_TAB, "A:L")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: "POST",
        body: JSON.stringify({ majorDimension: "ROWS", values: records.slice(offset, offset + 500).map(toSheetRow) })
      });
    }
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

  async function publishMainSheet(title, items) {
    const range = encodedRange(title, "A:H");
    await sheetsRequest(`/values/${range}:clear`, { method: "POST", body: "{}" });
    const values = [[
      "STT", "Câu hỏi", "Đáp án", "Từ khóa", "Ngày thêm", "Người thêm", "Ngày sửa", "Người sửa"
    ], ...items.map((item, index) => [
      String(index + 1), item.question, item.answer, item.keywords,
      displaySheetDate(item.createdAt), item.createdBy || "",
      item.updatedAt ? displaySheetDate(item.updatedAt) : "", item.updatedBy || ""
    ])];
    await sheetsRequest(`/values/${range}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ majorDimension: "ROWS", values })
    });
  }

  function displaySheetDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = number => String(number).padStart(2, "0");
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
    setStatus("Đang đồng bộ Google Sheets…");
    try {
      const sheets = await getSheets();
      state.remoteTitle = sheets.find(sheet => sheet.sheetId === 0)?.title || sheets[0]?.title;
      if (!state.remoteTitle) throw new Error("Google Sheets chưa có trang tính nào.");
      await ensureSyncTab(sheets);
      let remote = (await readRows(SYNC_TAB, "A2:L")).map(fromSheetRow).filter(Boolean);
      let initializedFromSheet = false;
      if (!remote.length) {
        const initial = await readInitialRecords(state.remoteTitle);
        if (initial.length) {
          await appendRecords(initial);
          remote.push(...initial);
          initializedFromSheet = true;
        }
      }
      const knownChanges = new Set(remote.map(record => record.changeId));
      const pending = state.records.filter(record => !knownChanges.has(record.changeId));
      if (pending.length) {
        await appendRecords(pending);
        remote = (await readRows(SYNC_TAB, "A2:L")).map(fromSheetRow).filter(Boolean);
      }

      let merged = mergeLatest([...state.records, ...remote]);
      const byQuestion = new Map();
      for (const record of merged.filter(record => !record.isDeleted)) {
        const previous = byQuestion.get(record.questionKey);
        if (!previous || compareRevision(record, previous) > 0) byQuestion.set(record.questionKey, record);
      }
      const losers = merged.filter(record => !record.isDeleted &&
        byQuestion.get(record.questionKey)?.entityId !== record.entityId);
      const tombstones = losers.map(loser => {
        const winner = byQuestion.get(loser.questionKey);
        return {
          ...loser,
          changedAt: new Date(new Date(winner.changedAt).getTime() + 1).toISOString(),
          changeId: `dedupe-${winner.changeId}-${loser.entityId}`,
          isDeleted: true
        };
      });
      if (tombstones.length) {
        await appendRecords(tombstones);
        merged = mergeLatest([...merged, ...tombstones]);
        remote.push(...tombstones);
      }
      const active = [...byQuestion.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.entityId.localeCompare(b.entityId)
      );
      const didChange = JSON.stringify(mergeLatest(state.records)) !== JSON.stringify(merged);
      if (didChange || initializedFromSheet || pending.length) {
        await publishMainSheet(state.remoteTitle, active);
      }
      state.records = merged;
      state.lastUpdated = new Date().toISOString();
      saveState();
      render();
      setStatus(`Đồng bộ xong lúc ${new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`, "connected");
      toast("Đã đồng bộ dữ liệu với Google Sheets.");
    } catch (error) {
      setStatus("Đồng bộ chưa thành công", "error");
      toast(error.message || "Không thể đồng bộ Google Sheets.", true);
    } finally {
      state.syncing = false;
      el.sync.disabled = !state.token;
      el.connect.disabled = false;
    }
  }

  function downloadBackup() {
    const payload = {
      format: "thu-vien-hoi-dap-web",
      version: 1,
      exportedAt: new Date().toISOString(),
      userName: state.userName,
      records: state.records
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `thu-vien-hoi-dap-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast("Đã tải bản sao lưu dữ liệu.");
  }

  async function restoreBackup(file) {
    try {
      const backup = JSON.parse(await file.text());
      if (backup.format !== "thu-vien-hoi-dap-web" || backup.version !== 1 || !Array.isArray(backup.records)) {
        throw new Error("File không phải bản sao lưu hợp lệ của Thư viện Hỏi đáp web.");
      }
      const valid = backup.records.every(record =>
        record && typeof record.entityId === "string" && typeof record.changeId === "string" &&
        typeof record.changedAt === "string" && typeof record.isDeleted === "boolean" &&
        typeof record.question === "string" && typeof record.questionKey === "string" &&
        typeof record.answer === "string" && typeof record.keywords === "string" &&
        typeof record.createdAt === "string" && typeof record.createdBy === "string" &&
        (record.updatedAt === null || typeof record.updatedAt === "string") &&
        (record.updatedBy === null || typeof record.updatedBy === "string")
      );
      if (!valid) throw new Error("Dữ liệu trong file sao lưu không hợp lệ.");
      if (!confirm(`Khôi phục ${backup.records.length} bản ghi? Dữ liệu hiện có trên thiết bị sẽ được thay thế; Google Sheets chỉ cập nhật sau khi bạn bấm Đồng bộ.`)) return;
      state.records = backup.records;
      state.userName = typeof backup.userName === "string" ? backup.userName : state.userName;
      state.selectedEntityId = null;
      state.lastUpdated = null;
      saveState();
      render();
      toast("Đã khôi phục trên thiết bị. Bấm “Đồng bộ” để cập nhật Google Sheets.");
    } catch (error) {
      toast(error.message || "Không thể khôi phục file.", true);
    } finally {
      el.importFile.value = "";
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

  function deleteSelected() {
    const item = activeRecords().find(record => record.entityId === state.selectedEntityId);
    if (!item || !confirm(`Bạn có chắc muốn xóa câu hỏi “${item.question}”?`)) return;
    state.records.push(newRevision(item, {}, true));
    state.selectedEntityId = null;
    saveState();
    render();
    toast("Đã xóa trên thiết bị. Bấm “Đồng bộ” để cập nhật Google Sheets.");
  }

  function connect() {
    requestAccessToken(true).then(() => toast("Đã kết nối Google. Bấm “Đồng bộ” để tải dữ liệu chung."))
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
  el.add.addEventListener("click", () => openEditor());
  el.edit.addEventListener("click", () => {
    const item = activeRecords().find(record => record.entityId === state.selectedEntityId);
    if (item) openEditor(item);
  });
  el.remove.addEventListener("click", deleteSelected);
  el.copy.addEventListener("click", copyAnswer);
  el.editorForm.addEventListener("submit", saveEditor);
  el.closeEditor.addEventListener("click", closeEditor);
  el.cancelEditor.addEventListener("click", closeEditor);
  el.editor.addEventListener("click", event => { if (event.target === el.editor) closeEditor(); });
  el.export.addEventListener("click", downloadBackup);
  el.importFile.addEventListener("change", () => {
    const file = el.importFile.files?.[0];
    if (file) restoreBackup(file);
  });

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
