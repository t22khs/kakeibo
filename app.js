'use strict';
const APP_VERSION = '1.4.0';

/* ========== IndexedDB（データはこの端末の中に保存） ========== */
const DB_NAME = 'kakeibo';
const DB_VERSION = 1;
let dbp = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}
const db = {
  all: () => tx('entries', 'readonly', s => s.getAll()),
  put: e => tx('entries', 'readwrite', s => s.put(e)),
  putMany: list => tx('entries', 'readwrite', s => list.forEach(e => s.put(e))),
  del: id => tx('entries', 'readwrite', s => s.delete(id)),
  delMany: ids => tx('entries', 'readwrite', s => ids.forEach(id => s.delete(id))),
  getMeta: k => tx('meta', 'readonly', s => s.get(k)),
  setMeta: (k, v) => tx('meta', 'readwrite', s => s.put(v, k)),
};

/* ========== 状態 ========== */
const DEFAULT_CATS = {
  expense: ['食費', '日用品', '住居', '水道光熱', '通信', '交通', '交際', '趣味', '衣服', '医療', 'その他'],
  income: ['給与', '賞与', '副収入', 'その他'],
};
const COLORS = ['#2f6f5e', '#d08a3c', '#4f7cac', '#b5527a', '#7a9a3a', '#8a6bbd', '#3a9aa0', '#c0533a', '#a08c5b', '#5c6b73', '#9c9c9c'];

const DEFAULT_BOOKS = [
  { id: 'household', name: '家計' },
  { id: 'me', name: '自分' },
];

const state = {
  entries: [],
  books: structuredClone(DEFAULT_BOOKS),
  book: 'household',          // いま表示している帳簿
  catsByBook: {},             // { bookId: { expense: [...], income: [...] } }
  budgetByBook: {},           // { bookId: 金額 }
  openingByBook: {},          // { bookId: { amount, date, setAt } } 残高を設定した時点の金額
  accountsByBook: {},         // { bookId: [{ id, name }] } お金の置き場所（口座・封筒など）
  openingByAccount: {},       // { accountId: { amount, date, setAt } }
  lastAcct: {},               // { bookId: accountId } 前回選んだ置き場所
  formAccount: null,
  formToAccount: null,
  formBook: 'household',
  ym: ymOf(new Date()),       // 表示中の期間（期間が始まる月）
  startDayByBook: {},         // { bookId: 1〜28 } 1か月の始まりの日
  filter: 'all',
  editing: null,
  formType: 'expense',
  formCat: null,
};
// いま表示している帳簿のカテゴリ・予算
const curCats = () => (state.catsByBook[state.book] ||= structuredClone(DEFAULT_CATS));
const catsOf = b => (state.catsByBook[b] ||= structuredClone(DEFAULT_CATS));
const curBudget = () => state.budgetByBook[state.book] || 0;

/* ========== 残高 ==========
   設定した時点の残高 ＋ それ以降に記録された収入 − 支出。
   ・設定日より前の日付の記録 → すでに残高に含まれているので数えない
   ・設定日と同じ日付の記録 → 設定より後に入力したものだけ数える */
function afterOpening(e, op) {
  return e.date > op.date || (e.date === op.date && e.createdAt > op.setAt);
}
function balanceAt(bookId, untilDate) {
  const op = state.openingByBook[bookId];
  if (!op) return null;
  if (untilDate < op.date) return undefined; // 設定前の期間
  return state.entries.reduce((sum, e) =>
    e.book === bookId && e.type !== 'transfer' && e.date <= untilDate && afterOpening(e, op)
      ? sum + (e.type === 'income' ? e.amount : -e.amount) : sum, op.amount);
}

/* 置き場所（口座・封筒）ごとの残高 */
const acctsOf = b => state.accountsByBook[b] || [];
const acctName = (b, id) => (acctsOf(b).find(a => a.id === id) || {}).name || '';
function acctDelta(e, accId) {
  if (e.type === 'transfer') return (e.toAccount === accId ? e.amount : 0) - (e.account === accId ? e.amount : 0);
  if (e.account !== accId) return 0;
  return e.type === 'income' ? e.amount : -e.amount;
}
function acctBalanceAt(bookId, accId, untilDate) {
  const op = state.openingByAccount[accId];
  if (!op) return null;
  if (untilDate < op.date) return undefined;
  return state.entries.reduce((sum, e) =>
    e.book === bookId && e.date <= untilDate && afterOpening(e, op) ? sum + acctDelta(e, accId) : sum, op.amount);
}
// 帳簿の残高：置き場所があればその合計、なければ帳簿全体の残高
function totalAt(bookId, untilDate) {
  const accts = acctsOf(bookId);
  if (!accts.length) return balanceAt(bookId, untilDate);
  const vals = accts.map(a => acctBalanceAt(bookId, a.id, untilDate));
  if (vals.every(v => v === null)) return null;
  const known = vals.filter(v => typeof v === 'number');
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
}
/* ========== 1か月の区切り ==========
   開始日 S のとき、期間 ym は「ym の S日 〜 翌月の S-1日」。S=1 ならふつうの月。 */
const startDay = (b = state.book) => state.startDayByBook[b] || 1;
const pad2 = n => String(n).padStart(2, '0');
const ds = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function periodRange(ym, b) {
  const S = startDay(b);
  const [y, m] = ym.split('-').map(Number);
  return { start: ds(new Date(y, m - 1, S)), end: ds(new Date(y, m, S - 1)) };
}
function periodOf(dateStr, b) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const ym = `${y}-${pad2(m)}`;
  return d >= startDay(b) ? ym : shiftYm(ym, -1);
}
const curPeriod = b => periodOf(todayStr(), b);
const md = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return ym + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0');
}
const bookName = id => (state.books.find(b => b.id === id) || {}).name || id;

/* ========== ユーティリティ ========== */
const $ = s => document.querySelector(s);
const yen = n => (n < 0 ? '-¥' : '¥') + Math.abs(Math.round(n)).toLocaleString('ja-JP');
function ymOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return ymOf(d) + '-' + String(d.getDate()).padStart(2, '0');
}
function shiftYm(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  return ymOf(new Date(y, m - 1 + delta, 1));
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const WD = ['日', '月', '火', '水', '木', '金', '土'];

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ========== 描画 ========== */
function monthEntries() {
  const { start, end } = periodRange(state.ym);
  return state.entries.filter(e => e.book === state.book && e.date >= start && e.date <= end)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

function render() {
  const [y, m] = state.ym.split('-');
  const { start, end } = periodRange(state.ym);
  const custom = startDay() > 1;
  $('#monthLabel').textContent = custom ? `${md(start)} 〜 ${md(end)}` : `${y}年${Number(m)}月`;
  $('#periodRange').hidden = !custom;
  $('#periodRange').textContent = custom ? (start.slice(0, 4) === end.slice(0, 4) ? `${y}年` : `${start.slice(0, 4)}〜${end.slice(0, 4)}年`) : '';
  document.body.dataset.book = state.book;
  renderBookSwitch();
  const list = monthEntries();
  renderAsset();
  renderSummary(list);
  renderDonut(list);
  renderRecent(list);
  renderHistory(list);
  $('#statusLine').textContent = `記録 ${state.entries.length}件 ・ v${APP_VERSION}`;
}

function renderBookSwitch() {
  $('#bookSwitch').innerHTML = state.books.map(b =>
    `<button class="book-btn ${b.id === state.book ? 'active' : ''}" data-book="${b.id}">${esc(b.name)}</button>`).join('');
}
async function switchBook(id) {
  const wasCur = state.ym === curPeriod();
  state.book = id;
  if (wasCur) state.ym = curPeriod();
  db.setMeta('currentBook', id);
  render();
  if ($('#view-settings').classList.contains('active')) renderSettings();
}

function renderAsset() {
  const accts = acctsOf(state.book);
  $('#acctList').hidden = true;
  if (accts.length) return renderAcctAsset(accts);
  const card = $('#assetCard');
  const op = state.openingByBook[state.book];
  if (!op) {
    card.classList.add('unset');
    $('#assetSub').hidden = false;
    $('#assetLabel').textContent = '残高';
    $('#assetValue').textContent = '＋ いまの残高を設定する';
    $('#assetSub').textContent = '設定すると、記録に合わせて残高が自動で増減します';
    return;
  }
  card.classList.remove('unset');
  $('#assetSub').hidden = false;
  const isCur = state.ym === curPeriod();
  const until = isCur ? '9999-12-31' : periodRange(state.ym).end;
  const bal = balanceAt(state.book, until);
  $('#assetLabel').textContent = isCur ? '現在の残高' : `${endLabel(until)}の残高`;
  if (bal === undefined) {
    $('#assetValue').textContent = '—';
    $('#assetSub').textContent = `残高を設定したのは ${fmtDate(op.date)} です`;
    return;
  }
  $('#assetValue').textContent = yen(bal);
  // 前の期間の終わりからの増減
  const prev = balanceAt(state.book, periodRange(shiftYm(state.ym, -1)).end);
  $('#assetSub').textContent = (prev === undefined || prev === null)
    ? `${fmtDate(op.date)} に ${yen(op.amount)} で設定`
    : `${prevLabel()}から ${bal - prev >= 0 ? '+' : ''}${yen(bal - prev)}`;
}
function renderAcctAsset(accts) {
  const card = $('#assetCard');
  if (accts.every(a => !state.openingByAccount[a.id])) {
    card.classList.add('unset');
    $('#assetLabel').textContent = '残高';
    $('#assetValue').textContent = '＋ 置き場所ごとの残高を設定する';
    $('#assetSub').textContent = accts.map(a => a.name).join('・');
    return;
  }
  card.classList.remove('unset');
  const isCur = state.ym === curPeriod();
  const until = isCur ? '9999-12-31' : periodRange(state.ym).end;
  $('#assetLabel').textContent = isCur ? '現在の残高（合計）' : `${endLabel(until)}の残高（合計）`;
  const total = totalAt(state.book, until);
  $('#assetValue').textContent = typeof total === 'number' ? yen(total) : '—';
  const prev = totalAt(state.book, periodRange(shiftYm(state.ym, -1)).end);
  $('#assetSub').textContent = typeof total === 'number' && typeof prev === 'number'
    ? `${prevLabel()}から ${total - prev >= 0 ? '+' : ''}${yen(total - prev)}` : '';
  $('#assetSub').hidden = !$('#assetSub').textContent;
  const list = $('#acctList');
  list.hidden = false;
  list.innerHTML = accts.map(a => {
    const v = acctBalanceAt(state.book, a.id, until);
    const txt = v === null ? '<span class="unset-amt">未設定</span>' : v === undefined ? '<span class="unset-amt">—</span>' : yen(v);
    return `<li><span>${esc(a.name)}</span><span>${txt}</span></li>`;
  }).join('');
}
const endLabel = d => startDay() > 1 ? md(d) : `${Number(d.slice(5, 7))}月末`;
const prevLabel = () => startDay() > 1 ? '前の期間の終わり' : '先月末';
function fmtDate(d) { const [y, m, dd] = d.split('-'); return `${y}/${Number(m)}/${Number(dd)}`; }

function renderSummary(list) {
  const inc = list.filter(e => e.type === 'income').reduce((a, e) => a + e.amount, 0);
  const exp = list.filter(e => e.type === 'expense').reduce((a, e) => a + e.amount, 0);
  $('#sumIncome').textContent = yen(inc);
  $('#sumExpense').textContent = yen(exp);
  const bal = $('#sumBalance');
  bal.textContent = yen(inc - exp);
  bal.className = 'value ' + (inc - exp < 0 ? 'expense' : 'income');

  const panel = $('#budgetPanel');
  const budget = curBudget();
  if (!budget) { panel.hidden = true; return; }
  panel.hidden = false;
  const rest = budget - exp;
  const pct = Math.min(100, (exp / budget) * 100);
  const bar = $('#budgetBar');
  bar.style.width = pct + '%';
  bar.classList.toggle('over', rest < 0);
  $('#budgetText').textContent = `${yen(exp)} / ${yen(budget)}`;

  let hint;
  if (rest < 0) hint = `予算を ${yen(-rest)} オーバーしています`;
  else {
    if (state.ym === curPeriod()) {
      const end = new Date(periodRange(state.ym).end + 'T00:00:00');
      const today = new Date(todayStr() + 'T00:00:00');
      const daysLeft = Math.round((end - today) / 86400000) + 1;
      hint = `残り ${yen(rest)}（あと${daysLeft}日・1日あたり ${yen(rest / daysLeft)}）`;
    } else hint = `残り ${yen(rest)}`;
  }
  $('#budgetHint').textContent = hint;
}

function renderDonut(list) {
  const byCat = {};
  list.filter(e => e.type === 'expense').forEach(e => (byCat[e.category] = (byCat[e.category] || 0) + e.amount));
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, r) => a + r[1], 0);
  const svg = $('#donut');
  const legend = $('#legend');

  if (!total) {
    svg.innerHTML = `<circle cx="60" cy="60" r="44" fill="none" stroke="var(--line)" stroke-width="16"/>
      <text x="60" y="64" text-anchor="middle" font-size="10" fill="var(--muted)">記録なし</text>`;
    legend.innerHTML = '<li class="muted">支出を記録するとここに表示されます</li>';
    return;
  }
  const r = 44, C = 2 * Math.PI * r;
  let off = 0, arcs = '';
  rows.forEach(([cat, v], i) => {
    const len = (v / total) * C;
    arcs += `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${colorFor(cat, i)}" stroke-width="16"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)"/>`;
    off += len;
  });
  svg.innerHTML = arcs +
    `<text x="60" y="57" text-anchor="middle" font-size="8" fill="var(--muted)">支出合計</text>
     <text x="60" y="70" text-anchor="middle" font-size="11" font-weight="700" fill="var(--text)">${yen(total)}</text>`;
  legend.innerHTML = rows.map(([cat, v], i) =>
    `<li><span class="dot" style="background:${colorFor(cat, i)}"></span><span class="name">${esc(cat)}</span>
     <span class="amt">${Math.round((v / total) * 100)}%</span></li>`).join('');
}
function colorFor(cat, i) {
  const idx = curCats().expense.indexOf(cat);
  return COLORS[(idx >= 0 ? idx : i) % COLORS.length];
}

function entryRow(e, showDate) {
  const [, m, d] = e.date.split('-');
  const isTr = e.type === 'transfer';
  const sign = isTr ? '' : e.type === 'income' ? '+' : '-';
  const where = isTr
    ? `${acctName(e.book, e.account) || '?'} → ${acctName(e.book, e.toAccount) || '?'}`
    : acctName(e.book, e.account);
  const memo = [where, e.memo].filter(Boolean).join(' · ');
  return `<li class="entry" data-id="${e.id}">
    ${showDate ? `<span class="d">${Number(m)}/${Number(d)}</span>` : ''}
    <span class="cat">${esc(isTr ? '振替' : e.category)}</span>
    <span class="memo">${esc(memo)}</span>
    <span class="amt ${e.type}">${sign}${yen(e.amount)}</span>
  </li>`;
}

function renderRecent(list) {
  const el = $('#recentList');
  el.innerHTML = list.length ? list.slice(0, 5).map(e => entryRow(e, true)).join('') : '<li class="empty">この月の記録はまだありません</li>';
}

function renderHistory(list) {
  const f = state.filter;
  const rows = f === 'all' ? list : list.filter(e => e.type === f);
  const el = $('#historyList');
  if (!rows.length) { el.innerHTML = '<p class="empty">記録がありません</p>'; return; }
  const groups = {};
  rows.forEach(e => (groups[e.date] ||= []).push(e));
  el.innerHTML = Object.keys(groups).sort().reverse().map(date => {
    const items = groups[date];
    const d = new Date(date + 'T00:00:00');
    const net = items.reduce((a, e) => a + (e.type === 'income' ? e.amount : e.type === 'expense' ? -e.amount : 0), 0);
    return `<div class="day-group"><div class="day-head"><span>${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）</span><span>${yen(net)}</span></div>
      <ul class="entries">${items.map(e => entryRow(e, false)).join('')}</ul></div>`;
  }).join('');
}

function renderSettings() {
  const name = bookName(state.book);
  document.querySelectorAll('.cur-book').forEach(el => (el.textContent = name));
  $('#budgetInput').value = curBudget() || '';
  const S = startDay();
  $('#startDay').innerHTML = Array.from({ length: 28 }, (_, i) => i + 1)
    .map(d => `<option value="${d}" ${d === S ? 'selected' : ''}>${d}</option>`).join('');
  $('#startDayEnd').textContent = S === 1 ? '末日' : `${S - 1}日`;
  const accts = acctsOf(state.book);
  $('#assetPanel').hidden = accts.length > 0;
  $('#acctEditor').innerHTML = accts.map(a => {
    const op = state.openingByAccount[a.id];
    const info = op
      ? `いまの残高 ${yen(acctBalanceAt(state.book, a.id, '9999-12-31'))}（${fmtDate(op.date)} に ${yen(op.amount)} で設定）`
      : '残高は未設定です';
    return `<div class="acct-row">
      <div class="acct-row-head">
        <input type="text" maxlength="10" value="${esc(a.name)}" data-acct-rename="${a.id}" aria-label="置き場所の名前">
        <button class="acct-del" data-acct-del="${a.id}" aria-label="削除">×</button>
      </div>
      <div class="row">
        <input type="text" inputmode="numeric" class="money" placeholder="いまの残高" data-acct-amt="${a.id}">
        <button class="btn" data-acct-set="${a.id}">残高を設定</button>
      </div>
      <p class="hint">${info}</p>
    </div>`;
  }).join('');
  const op = state.openingByBook[state.book];
  $('#assetInput').value = '';
  $('#assetSetInfo').textContent = op
    ? `現在の設定：${fmtDate(op.date)} 時点で ${yen(op.amount)}（いまの計算上の残高 ${yen(balanceAt(state.book, '9999-12-31'))}）`
    : 'まだ設定されていません。';
  $('#bookNames').innerHTML = state.books.map(b =>
    `<label class="book-name"><span class="swatch" data-book="${b.id}"></span>
      <input type="text" maxlength="8" value="${esc(b.name)}" data-rename="${b.id}"></label>`).join('');
  const cats = curCats();
  ['expense', 'income'].forEach(type => {
    $(type === 'expense' ? '#catExpense' : '#catIncome').innerHTML = cats[type]
      .map(c => `<button class="tag" data-del-cat="${esc(c)}" data-type="${type}">${esc(c)}<span class="x">×</span></button>`).join('');
  });
}

/* ========== 画面切り替え ========== */
function go(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.goto === view));
  $('#fab').hidden = view === 'settings';
  if (view === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

/* ========== 入力シート ========== */
function openSheet(entry) {
  state.editing = entry || null;
  state.formType = entry ? entry.type : 'expense';
  state.formBook = entry ? entry.book : state.book;
  state.formCat = entry ? entry.category : null;
  state.formAccount = entry ? entry.account : null;
  state.formToAccount = entry ? entry.toAccount : null;
  $('#amount').value = entry ? entry.amount.toLocaleString('ja-JP') : '';
  $('#date').value = entry ? entry.date : (state.ym === curPeriod() ? todayStr() : periodRange(state.ym).start);
  $('#memo').value = entry ? entry.memo || '' : '';
  $('#deleteEntry').hidden = !entry;
  syncSheet();
  $('#sheetBackdrop').hidden = false;
  $('#entryForm').hidden = false;
  if (!entry) setTimeout(() => $('#amount').focus(), 50);
}
function closeSheet() {
  $('#sheetBackdrop').hidden = true;
  $('#entryForm').hidden = true;
  state.editing = null;
}
function syncSheet() {
  const accts = acctsOf(state.formBook);
  const canTransfer = accts.length >= 2;
  $('#segTransfer').hidden = !canTransfer;
  if (state.formType === 'transfer' && !canTransfer) state.formType = 'expense';
  const isTr = state.formType === 'transfer';
  // 置き場所
  $('#acctPick').hidden = !accts.length;
  if (accts.length) {
    const ids = accts.map(a => a.id);
    if (!ids.includes(state.formAccount)) state.formAccount = ids.includes(state.lastAcct[state.formBook]) ? state.lastAcct[state.formBook] : ids[0];
    if (isTr && (!ids.includes(state.formToAccount) || state.formToAccount === state.formAccount))
      state.formToAccount = ids.find(id => id !== state.formAccount);
    $('#acctFromLabel').textContent = isTr ? '移す元' : state.formType === 'income' ? '入金先' : '支払い元';
    const pills = (sel, cur, attr) => ($(sel).innerHTML = accts.map(a =>
      `<button type="button" class="tag ${a.id === cur ? 'active' : ''}" ${attr}="${a.id}">${esc(a.name)}</button>`).join(''));
    pills('#acctFrom', state.formAccount, 'data-acct-from');
    $('#acctToWrap').hidden = !isTr;
    if (isTr) pills('#acctTo', state.formToAccount, 'data-acct-to');
  }
  $('#catPick').hidden = isTr;
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.type === state.formType));
  $('#formBook').innerHTML = state.books.map(b =>
    `<button type="button" class="book-pill ${b.id === state.formBook ? 'active' : ''}" data-form-book="${b.id}">${esc(b.name)}</button>`).join('');
  $('#entryForm').dataset.book = state.formBook;
  if (isTr) return;
  const cats = catsOf(state.formBook)[state.formType];
  if (!cats.includes(state.formCat)) state.formCat = cats[0];
  $('#catPick').innerHTML = cats.map(c =>
    `<button type="button" class="tag ${c === state.formCat ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
}

async function saveEntry(ev) {
  ev.preventDefault();
  const amount = parseInt($('#amount').value.replace(/[^\d]/g, ''), 10);
  if (!amount) { toast('金額を入力してください'); return; }
  const isEdit = !!state.editing;
  const accts = acctsOf(state.formBook);
  const isTr = state.formType === 'transfer';
  if (isTr && state.formAccount === state.formToAccount) { toast('移す元と移す先を別にしてください'); return; }
  const e = {
    id: state.editing ? state.editing.id : uid(),
    createdAt: state.editing ? state.editing.createdAt : Date.now(),
    book: state.formBook,
    type: state.formType,
    amount,
    category: isTr ? '振替' : state.formCat,
    date: $('#date').value || todayStr(),
    memo: $('#memo').value.trim(),
  };
  if (accts.length) {
    e.account = state.formAccount;
    if (isTr) e.toAccount = state.formToAccount;
    state.lastAcct[state.formBook] = state.formAccount;
    db.setMeta('lastAcct', state.lastAcct);
  }
  await db.put(e);
  const i = state.entries.findIndex(x => x.id === e.id);
  if (i >= 0) state.entries[i] = e; else state.entries.push(e);
  if (e.book === state.book) state.ym = periodOf(e.date);
  closeSheet();
  if (e.book !== state.book) { await switchBook(e.book); state.ym = periodOf(e.date); render(); } else render();
  toast((isEdit ? '更新しました' : '記録しました') + (state.books.length > 1 ? `（${bookName(e.book)}）` : ''));
}

/* ========== CSV ========== */
function toCsv() {
  const head = ['日付', '種別', 'カテゴリ', '金額', 'メモ', '帳簿', '記録日時', '置き場所', '振替先'];
  const TYPE = { income: '収入', expense: '支出', transfer: '振替' };
  const q = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const rows = [...state.entries].sort((a, b) => a.date.localeCompare(b.date))
    .map(e => [e.date, TYPE[e.type], e.category, e.amount, e.memo || '', bookName(e.book), new Date(e.createdAt || 0).toISOString(),
      acctName(e.book, e.account), e.type === 'transfer' ? acctName(e.book, e.toAccount) : ''].map(q).join(','));
  // 残高の設定もバックアップに入れる（メモ欄に設定した瞬間を記録）
  Object.entries(state.openingByBook).forEach(([bk, op]) =>
    rows.push([op.date, '残高設定', '', op.amount, new Date(op.setAt).toISOString(), bookName(bk)].map(q).join(',')));
  Object.entries(state.accountsByBook).forEach(([bk, accts]) => accts.forEach(a => {
    const op = state.openingByAccount[a.id];
    rows.push(op
      ? [op.date, '残高設定', '', op.amount, new Date(op.setAt).toISOString(), bookName(bk), '', a.name, ''].map(q).join(',')
      : ['', '置き場所', '', '', '', bookName(bk), '', a.name, ''].map(q).join(','));
  }));
  return '﻿' + [head.join(','), ...rows].join('\r\n');
}
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}
async function importCsv(file) {
  const rows = parseCsv(await file.text());
  if (rows.length && rows[0][0] === '日付') rows.shift();
  // 置き場所の並び順を保つため、置き場所・残高設定の行を先に読む
  const isSetup = r => r[1] === '置き場所' || r[1] === '残高設定';
  rows.sort((x, y) => isSetup(y) - isSetup(x));
  const list = [];
  let openings = 0;
  const ensureAcct = (bk, name) => {
    name = String(name || '').trim();
    if (!name) return undefined;
    const list = (state.accountsByBook[bk] ||= []);
    let a = list.find(x => x.name === name);
    if (!a) { a = { id: uid(), name }; list.push(a); }
    return a.id;
  };
  for (const [date, type, category, amount, memo, bookCol, createdCol, acctCol, toCol] of rows) {
    if (type === '置き場所') {
      const b = state.books.find(x => x.name === String(bookCol || '').trim());
      if (b) ensureAcct(b.id, acctCol);
      continue;
    }
    if (type === '残高設定') {
      const b = state.books.find(x => x.name === String(bookCol || '').trim());
      const setAt = Date.parse(memo);
      const amt = parseInt(String(amount).replace(/[^\d-]/g, ''), 10);
      if (b && !isNaN(amt) && !isNaN(setAt)) {
        const op = { amount: amt, date: String(date).trim(), setAt };
        const accId = ensureAcct(b.id, acctCol);
        if (accId) state.openingByAccount[accId] = op; else state.openingByBook[b.id] = op;
        openings++;
      }
      continue;
    }
    const amt = parseInt(String(amount).replace(/[^\d]/g, ''), 10);
    const d = String(date).trim().replace(/\//g, '-').replace(/-(\d)(?=-|$)/g, '-0$1');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !amt) continue;
    const t = type === '収入' ? 'income' : type === '振替' ? 'transfer' : 'expense';
    // 帳簿列がない古いCSVは、いま開いている帳簿に入れる
    const bk = (state.books.find(b => b.name === String(bookCol || '').trim()) || { id: state.book }).id;
    const cat = t === 'transfer' ? '振替' : (category || 'その他').trim();
    if (t !== 'transfer') { const cats = catsOf(bk); if (!cats[t].includes(cat)) cats[t].push(cat); }
    const ca = Date.parse(createdCol);
    const e = { id: uid(), createdAt: isNaN(ca) ? Date.now() : ca, book: bk, date: d, type: t, category: cat, amount: amt, memo: (memo || '').trim() };
    const acc = ensureAcct(bk, acctCol);
    if (acc) e.account = acc;
    if (t === 'transfer') { const to = ensureAcct(bk, toCol); if (!acc || !to) continue; e.toAccount = to; }
    list.push(e);
  }
  if (openings) { await db.setMeta('openingByBook', state.openingByBook); await db.setMeta('openingByAccount', state.openingByAccount); }
  await db.setMeta('accountsByBook', state.accountsByBook);
  if (!list.length) {
    if (openings) { render(); renderSettings(); toast('残高の設定を読み込みました'); }
    else toast('読み込める行がありませんでした');
    return;
  }
  // 同じ内容の記録は重複させない
  const key = e => [e.book, e.date, e.type, e.category, e.amount, e.memo, e.account || '', e.toAccount || ''].join('|');
  const have = new Set(state.entries.map(key));
  const fresh = list.filter(e => !have.has(key(e)));
  await db.putMany(fresh);
  await db.setMeta('catsByBook', state.catsByBook);
  state.entries.push(...fresh);
  render(); renderSettings();
  toast(`${fresh.length}件を読み込みました` + (list.length > fresh.length ? `（重複${list.length - fresh.length}件はスキップ）` : ''));
}

function moneyInput(e) {
  const v = e.target.value.trim();
  const neg = v.startsWith('-') || v.startsWith('−');
  const n = v.replace(/[^\d]/g, '');
  e.target.value = n ? (neg ? '-' : '') + Number(n).toLocaleString('ja-JP') : (neg ? '-' : '');
}

/* ========== イベント ========== */
function bind() {
  $('#bookSwitch').onclick = e => {
    const b = e.target.closest('[data-book]');
    if (b && b.dataset.book !== state.book) switchBook(b.dataset.book);
  };
  $('#formBook').onclick = e => {
    const b = e.target.closest('[data-form-book]');
    if (b) { state.formBook = b.dataset.formBook; syncSheet(); }
  };
  $('#bookNames').onchange = async e => {
    const id = e.target.dataset.rename;
    if (!id) return;
    const name = e.target.value.trim();
    if (!name) { renderSettings(); return; }
    state.books.find(b => b.id === id).name = name;
    await db.setMeta('books', state.books);
    render(); renderSettings(); toast('名前を変更しました');
  };
  $('#prevMonth').onclick = () => { state.ym = shiftYm(state.ym, -1); render(); };
  $('#nextMonth').onclick = () => { state.ym = shiftYm(state.ym, 1); render(); };
  document.querySelectorAll('[data-goto]').forEach(b => (b.onclick = () => go(b.dataset.goto)));
  $('#fab').onclick = () => openSheet();
  $('#sheetBackdrop').onclick = closeSheet;
  $('#cancelEntry').onclick = closeSheet;
  $('#entryForm').onsubmit = saveEntry;

  document.querySelectorAll('.seg-btn').forEach(b => (b.onclick = () => { state.formType = b.dataset.type; syncSheet(); }));
  $('#acctPick').onclick = e => {
    const f = e.target.closest('[data-acct-from]'), t = e.target.closest('[data-acct-to]');
    if (f) { state.formAccount = f.dataset.acctFrom; if (state.formToAccount === state.formAccount) state.formToAccount = null; }
    else if (t) state.formToAccount = t.dataset.acctTo;
    else return;
    syncSheet();
  };
  $('#catPick').onclick = e => {
    const b = e.target.closest('[data-cat]');
    if (b) { state.formCat = b.dataset.cat; syncSheet(); }
  };
  $('#amount').oninput = e => {
    const n = e.target.value.replace(/[^\d]/g, '');
    e.target.value = n ? Number(n).toLocaleString('ja-JP') : '';
  };
  $('#deleteEntry').onclick = async () => {
    if (!state.editing || !confirm('この記録を削除しますか？')) return;
    await db.del(state.editing.id);
    state.entries = state.entries.filter(x => x.id !== state.editing.id);
    closeSheet(); render(); toast('削除しました');
  };

  document.body.addEventListener('click', e => {
    const row = e.target.closest('.entry');
    if (row) openSheet(state.entries.find(x => x.id === row.dataset.id));
  });

  document.querySelectorAll('.chip').forEach(c => (c.onclick = () => {
    state.filter = c.dataset.filter;
    document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c));
    renderHistory(monthEntries());
  }));

  $('#assetCard').onclick = () => {
    go('settings');
    const hasAccts = acctsOf(state.book).length > 0;
    setTimeout(() => {
      $(hasAccts ? '#acctPanel' : '#assetPanel').scrollIntoView({ block: 'start' });
      if (!hasAccts) $('#assetInput').focus();
    }, 50);
  };
  $('#assetInput').oninput = moneyInput;
  $('#acctEditor').addEventListener('input', e => { if (e.target.classList.contains('money')) moneyInput(e); });
  $('#acctEditor').onchange = async e => {
    const id = e.target.dataset.acctRename;
    if (!id) return;
    const name = e.target.value.trim();
    const a = acctsOf(state.book).find(x => x.id === id);
    if (!name || acctsOf(state.book).some(x => x.name === name && x.id !== id)) { toast(name ? '同じ名前があります' : '名前を入力してください'); renderSettings(); return; }
    a.name = name;
    await db.setMeta('accountsByBook', state.accountsByBook);
    render(); renderSettings(); toast('名前を変更しました');
  };
  $('#acctEditor').onclick = async e => {
    const set = e.target.closest('[data-acct-set]'), del = e.target.closest('[data-acct-del]');
    if (set) {
      const id = set.dataset.acctSet;
      const raw = $(`[data-acct-amt="${id}"]`).value.trim();
      const amt = parseInt(raw.replace(/[^\d-]/g, ''), 10);
      if (!raw || isNaN(amt)) { toast('残高を入力してください'); return; }
      const name = acctName(state.book, id);
      const had = !!state.openingByAccount[id];
      if (had && !confirm(`「${name}」の残高を ${yen(amt)} に設定し直しますか？`)) return;
      state.openingByAccount[id] = { amount: amt, date: todayStr(), setAt: Date.now() };
      await db.setMeta('openingByAccount', state.openingByAccount);
      render(); renderSettings(); toast(`${name}の残高を設定しました`);
    } else if (del) {
      const id = del.dataset.acctDel, name = acctName(state.book, id);
      if (!confirm(`「${name}」を削除しますか？\n過去の記録は残りますが、この置き場所の残高は表示されなくなります。`)) return;
      state.accountsByBook[state.book] = acctsOf(state.book).filter(a => a.id !== id);
      delete state.openingByAccount[id];
      await db.setMeta('accountsByBook', state.accountsByBook);
      await db.setMeta('openingByAccount', state.openingByAccount);
      render(); renderSettings(); toast('削除しました');
    }
  };
  $('#addAcct').onclick = async () => {
    const name = $('#newAcctName').value.trim();
    if (!name) { toast('名前を入力してください'); return; }
    const list = (state.accountsByBook[state.book] ||= []);
    if (list.some(a => a.name === name)) { toast('同じ名前があります'); return; }
    list.push({ id: uid(), name });
    await db.setMeta('accountsByBook', state.accountsByBook);
    $('#newAcctName').value = '';
    render(); renderSettings(); toast(`「${name}」を追加しました。残高を設定してください`);
  };
  $('#saveAsset').onclick = async () => {
    const raw = $('#assetInput').value.trim();
    if (!raw) { toast('残高を入力してください'); return; }
    const amt = parseInt(raw.replace(/[^\d-]/g, ''), 10);
    if (isNaN(amt)) { toast('数字で入力してください'); return; }
    const had = !!state.openingByBook[state.book];
    if (had && !confirm(`「${bookName(state.book)}」の残高を ${yen(amt)} に設定し直しますか？`)) return;
    state.openingByBook[state.book] = { amount: amt, date: todayStr(), setAt: Date.now() };
    await db.setMeta('openingByBook', state.openingByBook);
    render(); renderSettings();
    toast(had ? '残高を設定し直しました' : '残高を設定しました');
  };
  $('#startDay').onchange = async e => {
    const wasCur = state.ym === curPeriod();
    state.startDayByBook[state.book] = Number(e.target.value);
    await db.setMeta('startDayByBook', state.startDayByBook);
    if (wasCur) state.ym = curPeriod();
    render(); renderSettings();
    toast(Number(e.target.value) === 1 ? '1日始まりにしました' : `${e.target.value}日始まりにしました`);
  };
  $('#saveBudget').onclick = async () => {
    state.budgetByBook[state.book] = Math.max(0, parseInt($('#budgetInput').value, 10) || 0);
    await db.setMeta('budgetByBook', state.budgetByBook);
    render(); toast('予算を保存しました');
  };

  $('#exportCsv').onclick = () => {
    if (!state.entries.length) { toast('書き出す記録がありません'); return; }
    const blob = new Blob([toCsv()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kakeibo-${todayStr()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    db.setMeta('lastExport', Date.now());
    toast('CSVを書き出しました');
  };
  $('#importCsv').onchange = async e => {
    const f = e.target.files[0];
    if (f) await importCsv(f);
    e.target.value = '';
  };

  $('#addCat').onclick = async () => {
    const name = $('#newCatName').value.trim();
    const type = $('#newCatType').value;
    if (!name) return;
    const cats = curCats();
    if (cats[type].includes(name)) { toast('同じ名前のカテゴリがあります'); return; }
    cats[type].push(name);
    await db.setMeta('catsByBook', state.catsByBook);
    $('#newCatName').value = '';
    renderSettings(); toast('追加しました');
  };
  ['#catExpense', '#catIncome'].forEach(sel => ($(sel).onclick = async e => {
    const b = e.target.closest('[data-del-cat]');
    if (!b) return;
    const type = b.dataset.type, name = b.dataset.delCat;
    const cats = curCats();
    if (cats[type].length <= 1) { toast('カテゴリは1つ以上必要です'); return; }
    if (!confirm(`カテゴリ「${name}」を一覧から外しますか？\n（過去の記録はそのまま残ります）`)) return;
    cats[type] = cats[type].filter(c => c !== name);
    await db.setMeta('catsByBook', state.catsByBook);
    renderSettings();
  }));

  $('#wipe').onclick = async () => {
    const name = bookName(state.book);
    const mine = state.entries.filter(e => e.book === state.book);
    if (!mine.length) { toast(`「${name}」に記録はありません`); return; }
    if (!confirm(`「${name}」の記録 ${mine.length}件をすべて削除します。元に戻せません。\n先にCSVで書き出しましたか？`)) return;
    if (!confirm('本当に削除しますか？')) return;
    await db.delMany(mine.map(e => e.id));
    state.entries = state.entries.filter(e => e.book !== state.book);
    render(); toast('削除しました');
  };
}

/* ========== 起動 ========== */
async function init() {
  bind();
  try {
    const [entries, books, current, catsByBook, budgetByBook, oldCats, oldBudget, openingByBook] = await Promise.all([
      db.all(), db.getMeta('books'), db.getMeta('currentBook'),
      db.getMeta('catsByBook'), db.getMeta('budgetByBook'), db.getMeta('cats'), db.getMeta('budget'),
      db.getMeta('openingByBook'),
    ]);
    state.openingByBook = openingByBook || {};
    const [accountsByBook, openingByAccount, lastAcct] = await Promise.all([
      db.getMeta('accountsByBook'), db.getMeta('openingByAccount'), db.getMeta('lastAcct')]);
    state.accountsByBook = accountsByBook || {};
    state.openingByAccount = openingByAccount || {};
    state.lastAcct = lastAcct || {};
    state.startDayByBook = (await db.getMeta('startDayByBook')) || {};
    if (books) state.books = books;
    state.catsByBook = catsByBook || {};
    state.budgetByBook = budgetByBook || {};
    // v1.0 からの引き継ぎ：帳簿のない記録・設定は「家計」へ
    const legacy = (entries || []).filter(e => !e.book);
    legacy.forEach(e => (e.book = 'household'));
    if (legacy.length) await db.putMany(legacy);
    if (!catsByBook && oldCats) { state.catsByBook.household = oldCats; await db.setMeta('catsByBook', state.catsByBook); }
    if (!budgetByBook && oldBudget) { state.budgetByBook.household = oldBudget; await db.setMeta('budgetByBook', state.budgetByBook); }
    state.entries = entries || [];
    if (current && state.books.some(b => b.id === current)) state.book = current;
    state.ym = curPeriod();
    // ブラウザに「データを消さないで」と頼む（対応ブラウザのみ）
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (err) {
    toast('データを読み込めませんでした');
    console.error(err);
  }
  render();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
}
init();
