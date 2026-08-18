'use strict';

const KEYS = { TOKEN: 'ehelper_access_token', EXPIRE: 'ehelper_expires_at', EMAIL: 'ehelper_user_email', NAME: 'ehelper_user_name', AVATAR: 'ehelper_avatar', KW: 'keywords', RECORDS: 'records', CID: 'ehelper_client_id' };
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

// ---------- 工具函数 ----------
const $ = (id) => document.getElementById(id);
let toastTimer = null;
function toast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = type || '';
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch (e) { return fallback; }
}
function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function lsRemove(key) { localStorage.removeItem(key); }

function getToken() { return localStorage.getItem(KEYS.TOKEN); }
function getExpiresAt() { return parseInt(localStorage.getItem(KEYS.EXPIRE) || '0', 10); }
function tokenValid() {
  return !!getToken() && getExpiresAt() > (Date.now() + 60000);
}
function clearToken() {
  lsRemove(KEYS.TOKEN); lsRemove(KEYS.EXPIRE);
}

function decodeBase64Url(b64) {
  if (!b64) return '';
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  switch (s.length % 4) {
    case 0: break;
    case 2: s += '=='; break;
    case 3: s += '='; break;
    default: return '';
  }
  try { return decodeURIComponent(escape(atob(s))); }
  catch (e) {
    try { return atob(s); } catch (e2) { return ''; }
  }
}

function decodeHeader(value) {
  if (!value) return '';
  // RFC 2047 编码的标题（=?UTF-8?B?...?= 或 ?Q?...?=）
  const out = value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, enc, data) => {
    try {
      if (enc.toLowerCase() === 'b') {
        return decodeBase64Url(data);
      } else {
        return decodeURIComponent(data.replace(/_(?!\s)/g, '%20').replace(/=/g, '%'));
      }
    } catch (e) { return m; }
  });
  return out;
}

// ---------- 关键词 ----------
function getKeywords() { return lsGet(KEYS.KW, []); }
function setKeywords(list) { lsSet(KEYS.KW, list); }

function renderKeywords() {
  const list = getKeywords();
  const wrap = $('kw-list');
  if (!list.length) {
    wrap.innerHTML = '<span class="empty-tip">尚未添加关键词，可添加如「信用卡」「还款」等。</span>';
    return;
  }
  wrap.innerHTML = '';
  list.forEach((kw, i) => {
    const chip = document.createElement('span');
    chip.className = 'kw-chip';
    chip.textContent = kw;
    const btn = document.createElement('button');
    btn.title = '删除';
    btn.innerHTML = '<span class="material-icons">close</span>';
    btn.addEventListener('click', () => {
      const arr = getKeywords();
      arr.splice(i, 1);
      setKeywords(arr);
      renderKeywords();
      toast('已删除关键词', 'success');
    });
    chip.appendChild(btn);
    wrap.appendChild(chip);
  });
}

function addKeyword() {
  const input = $('kw-input');
  const kw = input.value.trim();
  if (!kw) { toast('请输入关键词'); return; }
  const arr = getKeywords();
  if (arr.includes(kw)) { toast('该关键词已存在'); return; }
  arr.push(kw);
  setKeywords(arr);
  input.value = '';
  renderKeywords();
  toast('关键词已添加', 'success');
}

// ---------- 记录 ----------
function getRecords() { return lsGet(KEYS.RECORDS, []); }
function setRecords(list) { lsSet(KEYS.RECORDS, list); }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderRecords() {
  const records = getRecords().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const body = $('records-body');
  $('record-count').textContent = records.length ? `共 ${records.length} 条记录（最近在上）` : '';
  $('no-records').style.display = records.length ? 'none' : 'block';
  body.innerHTML = '';
  records.forEach(r => {
    const tr = document.createElement('tr');
    const keywords = (r.keywords || []).map(k => `<span class="k-tag">${escapeHtml(k)}</span>`).join('');
    const hasAmount = r.amount != null && r.amount !== '';
    tr.innerHTML =
      `<td class="date">${escapeHtml(r.date || '')}</td>` +
      `<td title="${escapeHtml(r.from)}">${escapeHtml(r.from || '')}</td>` +
      `<td class="subject" title="${escapeHtml(r.subject)}">${escapeHtml(r.subject || '')}</td>` +
      `<td class="keywords">${keywords || '<span style="color:var(--muted)">-</span>'}</td>` +
      `<td class="amount${hasAmount ? '' : ' none'}">${escapeHtml(hasAmount ? r.amount : '未提取')}</td>`;
    body.appendChild(tr);
  });
}

// ---------- 邮件解析 ----------
function getHeader(headers, name) {
  if (!headers) return '';
  const h = headers.find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? decodeHeader(h.value) : '';
}

function walkParts(part, found) {
  if (part.mimeType === 'text/plain') {
    found.text = decodeBase64Url(part.body && part.body.data);
    return;
  }
  if (part.mimeType === 'text/html' && found.text === '') {
    found.html = decodeBase64Url(part.body && part.body.data);
    return;
  }
  if (part.parts) {
    // 优先找 text/plain
    part.parts.forEach(p => {
      if (p.mimeType === 'text/plain' && found.text === '') found.text = decodeBase64Url(p.body && p.body.data);
    });
    part.parts.forEach(p => {
      if (p.mimeType === 'text/html' && found.html === '') found.html = decodeBase64Url(p.body && p.body.data);
    });
    part.parts.forEach(p => walkParts(p, found));
  }
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- 金额提取 ----------
const AMOUNT_PATTERNS = [
  /(?:金额|金額|还款|還款|还款金额|还贷|消費|消费|应付|應付|支付|账单|帳單)[：:]\s*[¥￥]?\s*([\d][\d,]*\.?\d*)/g,
  /[¥￥]\s*([\d][\d,]*\.?\d*)/g,
  /(?:due|amount|total|balance)[：: ]\s*[¥$￥]?\s*([\d][\d,]*\.?\d*)/gi
];

function extractAmounts(text) {
  const amounts = [];
  const seen = new Set();
  const push = (v) => {
    if (!seen.has(v)) { seen.add(v); amounts.push(v); }
  };
  AMOUNT_PATTERNS.forEach(re => {
    let m;
    while ((m = re.exec(text)) !== null) push(m[1]);
  });
  return amounts;
}

function parseAmountValue(str) {
  return parseFloat(String(str).replace(/,/g, ''));
}

// ---------- 扫描 ----------
async function apiFetch(url) {
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + getToken() }
  });
  if (res.status === 401) {
    throw new ApiError('登录已过期，请重新登录', true);
  }
  if (!res.ok) {
    let msg = '请求失败 (' + res.status + ')';
    try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
    throw new ApiError(msg, false);
  }
  return res.json();
}

class ApiError extends Error {
  constructor(msg, needsReauth) { super(msg); this.needsReauth = needsReauth; }
}

async function fetchMessageList(q, count) {
  const messages = [];
  let pageToken = '';
  do {
    let url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100';
    if (q) url += '&q=' + encodeURIComponent(q);
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    const data = await apiFetch(url);
    if (data.messages) messages.push(...data.messages);
    pageToken = data.nextPageToken || '';
    if (count !== 'all' && messages.length >= count) {
      messages.length = count;
      break;
    }
  } while (pageToken);
  return messages;
}

async function scanEmails() {
  const btn = $('scan-btn');
  const progress = $('scan-progress');
  const bar = $('scan-bar');
  const status = $('scan-status');

  if (!tokenValid()) { toast('登录已过期，请重新登录', 'error'); showLogin(); return; }

  const keywords = getKeywords();
  if (!keywords.length) { toast('请先添加至少一个关键词', 'error'); return; }

  const from = $('scan-from').value.trim();
  const exclFrom = $('scan-exclude-from').value.trim();
  const qParts = [];
  if (from) qParts.push('from:' + from);
  if (exclFrom) {
    exclFrom.split(/[,，\s]+/).filter(Boolean).forEach(a => qParts.push('-from:' + a));
  }
  if ($('excl-promo').checked) qParts.push('-category:promotions');
  if ($('excl-social').checked) qParts.push('-category:social');
  if ($('excl-forums').checked) qParts.push('-category:forums');
  if ($('excl-updates').checked) qParts.push('-category:updates');
  const q = qParts.join(' ');
  const count = $('scan-count').value;

  if (count === 'all' && !confirm('扫描全部邮件可能非常耗时（可能是数千封），确定继续吗？')) return;

  btn.disabled = true;
  progress.style.display = 'block';
  bar.style.width = '0%';
  status.textContent = '正在获取邮件列表…';

  try {
    // 1. 按筛选条件获取邮件（支持分页，最多 count 封，全部则翻到底）
    const messages = await fetchMessageList(q, count);
    if (!messages.length) {
      status.textContent = '筛选条件下无邮件';
      $('last-scan').textContent = '上次扫描：' + new Date().toLocaleString('zh-CN') +
        (q ? `（筛选：${q}）` : '') + '（无匹配邮件）';
      return;
    }

    const newRecords = [];
    let done = 0;

    for (const m of messages) {
      // 2. 获取完整邮件内容
      const msg = await apiFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + m.id + '?format=full');
      done++;
      bar.style.width = Math.round((done / messages.length) * 100) + '%';
      status.textContent = `正在分析 ${done}/${messages.length} 封…`;

      const headers = msg.payload && msg.payload.headers;
      const from = getHeader(headers, 'From');
      const subject = getHeader(headers, 'Subject');
      const dateRaw = getHeader(headers, 'Date');
      const internalDate = msg.internalDate;

      const found = { text: '', html: '' };
      if (msg.payload) walkParts(msg.payload, found);
      let content = (found.text || htmlToText(found.html) || '').toLowerCase();
      const originalContent = found.text || htmlToText(found.html) || '';

      // 3. 关键词匹配
      const matched = keywords.filter(kw => {
        const needle = String(kw).toLowerCase();
        return content.includes(needle) || subject.toLowerCase().includes(needle);
      });

      if (!matched.length) continue;

      // 4. 提取金额
      const amounts = extractAmounts(originalContent);
      let displayAmount = '';
      if (amounts.length) {
        let best = amounts[0];
        let bestVal = parseAmountValue(best);
        amounts.forEach(a => {
          const v = parseAmountValue(a);
          if (v > bestVal) { best = a; bestVal = v; }
        });
        displayAmount = best;
      }

      newRecords.push({
        id: m.id,
        ts: internalDate ? parseInt(internalDate, 10) : Date.now(),
        date: internalDate ? new Date(parseInt(internalDate, 10)).toLocaleString('zh-CN') : new Date().toLocaleString('zh-CN'),
        from: from,
        subject: subject,
        keywords: matched,
        amount: displayAmount,
        scannedAt: Date.now()
      });
    }

    // 5. 去重合并
    const existing = getRecords();
    const existingIds = new Set(existing.map(r => r.id));
    const fresh = newRecords.filter(r => !existingIds.has(r.id));
    const merged = fresh.concat(existing);
    setRecords(merged);

    renderRecords();
    status.textContent = '';
    $('last-scan').textContent = '上次扫描：' + new Date().toLocaleString('zh-CN') +
      (q ? `（筛选：${q}）` : '') +
      `（共扫描 ${messages.length} 封，新匹配 ${fresh.length} 条）`;
    toast(fresh.length ? `扫描完成，新增 ${fresh.length} 条记录` : '扫描完成，无新增匹配', fresh.length ? 'success' : '');
  } catch (err) {
    console.error(err);
    if (err.needsReauth) {
      toast('登录已过期，请重新登录', 'error');
      showLogin();
    } else {
      toast(err.message || '扫描失败，请重试', 'error');
    }
    status.textContent = '扫描失败';
  } finally {
    btn.disabled = false;
    progress.style.display = 'none';
    bar.style.width = '0%';
  }
}

// ---------- 登录 / 登出 ----------
let gisClient = null;

function showOverlay(msg) {
  $('overlay-msg').textContent = msg;
  $('overlay').classList.add('show');
}
function hideOverlay() { $('overlay').classList.remove('show'); }

function getClientId() {
  return localStorage.getItem(KEYS.CID) || $('client-id').value.trim();
}

function initGis() {
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
    toast('Google 登录库加载失败，请检查网络', 'error');
    return false;
  }
  const clientId = getClientId();
  if (!clientId) { toast('请先填写 Google OAuth 客户端 ID', 'error'); return false; }
  gisClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GMAIL_SCOPE,
    callback: (resp) => {
      if (resp && resp.access_token) {
        localStorage.setItem(KEYS.TOKEN, resp.access_token);
        localStorage.setItem(KEYS.EXPIRE, String(Date.now() + (resp.expires_in || 3600) * 1000));
        const profile = resp.profile || {};
        if (profile.email) localStorage.setItem(KEYS.EMAIL, profile.email);
        if (profile.name) localStorage.setItem(KEYS.NAME, profile.name);
        if (profile.picture) localStorage.setItem(KEYS.AVATAR, profile.picture);
        showDashboard();
        toast('登录成功', 'success');
      } else {
        toast('授权失败：' + (resp.error || '未知错误'), 'error');
      }
    }
  });
  return true;
}

function login() {
  const clientId = getClientId();
  if (!clientId) { toast('请先填写 Google OAuth 客户端 ID', 'error'); return; }
  localStorage.setItem(KEYS.CID, clientId);
  if (!initGis()) return;
  gisClient.requestAccessToken();
}

function logout() {
  clearToken();
  lsRemove(KEYS.EMAIL); lsRemove(KEYS.NAME); lsRemove(KEYS.AVATAR);
  if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
    try { google.accounts.id.disableAutoSelect(); } catch (e) {}
  }
  showLogin();
  toast('已退出登录');
}

function showLogin() {
  $('login-section').style.display = 'flex';
  $('dashboard').style.display = 'none';
  $('client-id').value = localStorage.getItem(KEYS.CID) || '';
}

function showDashboard() {
  $('login-section').style.display = 'none';
  $('dashboard').style.display = 'block';
  const email = localStorage.getItem(KEYS.EMAIL);
  const name = localStorage.getItem(KEYS.NAME);
  const avatar = localStorage.getItem(KEYS.AVATAR);
  if (email) {
    $('user-email').textContent = name ? `${name} · ${email}` : email;
    $('user-email').title = email;
  } else {
    $('user-email').textContent = '已登录';
  }
  if (avatar) { $('user-avatar').src = avatar; }
  renderKeywords();
  renderRecords();
  const last = getRecords().length ? getRecords().sort((a, b) => (a.scannedAt || 0) - (b.scannedAt || 0)).pop().scannedAt : null;
  if (last) $('last-scan').textContent = '上次扫描：' + new Date(last).toLocaleString('zh-CN');
}

// ---------- 初始化 ----------
function init() {
  // 事件绑定
  $('login-btn').addEventListener('click', login);
  $('logout-btn').addEventListener('click', logout);
  $('kw-add').addEventListener('click', addKeyword);
  $('kw-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addKeyword(); });
  $('scan-btn').addEventListener('click', scanEmails);
  $('clear-btn').addEventListener('click', () => {
    if (getRecords().length && confirm('确定清空所有扫描记录吗？此操作不可恢复。')) {
      setRecords([]);
      renderRecords();
      toast('记录已清空');
    }
  });

  // 检查登录状态
  if (tokenValid()) {
    // 拉取用户信息
    (async () => {
      try {
        const info = await apiFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile');
        if (info.emailAddress) {
          localStorage.setItem(KEYS.EMAIL, info.emailAddress);
          const parts = info.emailAddress.split('@');
          if (!localStorage.getItem(KEYS.NAME)) localStorage.setItem(KEYS.NAME, parts[0]);
        }
      } catch (e) {
        if (e.needsReauth) { showLogin(); return; }
      }
      showDashboard();
    })();
  } else {
    showLogin();
  }
}

document.addEventListener('DOMContentLoaded', init);