'use strict';
const APP_VERSION = '1.1.0';

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
  formBook: 'household',
  ym: ymOf(new Date()),
  filter: 'all',
  editing: null,
  formType: 'expense',
  formCat: null,
};
// いま表示している帳簿のカテゴリ・予算
const curCats = () => (state.catsByBook[state.book] ||= structuredClone(DEFAULT_CATS));
const catsOf = b => (state.catsByBook[b] ||= structuredClone(DEFAULT_CATS));
const curBudget = () => state.budgetByBook[state.book] || 0;
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
  return state.entries.filter(e => e.book === state.book && e.date.startsWith(state.ym))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

function render() {
  const [y, m] = state.ym.split('-');
  $('#monthLabel').textContent = `${y}年${Number(m)}月`;
  document.body.dataset.book = state.book;
  renderBookSwitch();
  const list = monthEntries();
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
  state.book = id;
  db.setMeta('currentBook', id);
  render();
  if ($('#view-settings').classList.contains('active')) renderSettings();
}

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
    const now = new Date();
    if (state.ym === ymOf(now)) {
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysLeft = last - now.getDate() + 1;
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
  const sign = e.type === 'income' ? '+' : '-';
  return `<li class="entry" data-id="${e.id}">
    ${showDate ? `<span class="d">${Number(m)}/${Number(d)}</span>` : ''}
    <span class="cat">${esc(e.category)}</span>
    <span class="memo">${esc(e.memo || '')}</span>
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
    const net = items.reduce((a, e) => a + (e.type === 'income' ? e.amount : -e.amount), 0);
    return `<div class="day-group"><div class="day-head"><span>${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）</span><span>${yen(net)}</span></div>
      <ul class="entries">${items.map(e => entryRow(e, false)).join('')}</ul></div>`;
  }).join('');
}

function renderSettings() {
  const name = bookName(state.book);
  document.querySelectorAll('.cur-book').forEach(el => (el.textContent = name));
  $('#budgetInput').value = curBudget() || '';
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
  $('#amount').value = entry ? entry.amount.toLocaleString('ja-JP') : '';
  $('#date').value = entry ? entry.date : (state.ym === ymOf(new Date()) ? todayStr() : state.ym + '-01');
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
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.type === state.formType));
  $('#formBook').innerHTML = state.books.map(b =>
    `<button type="button" class="book-pill ${b.id === state.formBook ? 'active' : ''}" data-form-book="${b.id}">${esc(b.name)}</button>`).join('');
  $('#entryForm').dataset.book = state.formBook;
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
  const e = {
    id: state.editing ? state.editing.id : uid(),
    createdAt: state.editing ? state.editing.createdAt : Date.now(),
    book: state.formBook,
    type: state.formType,
    amount,
    category: state.formCat,
    date: $('#date').value || todayStr(),
    memo: $('#memo').value.trim(),
  };
  await db.put(e);
  const i = state.entries.findIndex(x => x.id === e.id);
  if (i >= 0) state.entries[i] = e; else state.entries.push(e);
  if (!e.date.startsWith(state.ym)) state.ym = e.date.slice(0, 7);
  closeSheet();
  if (e.book !== state.book) { await switchBook(e.book); } else render();
  toast((isEdit ? '更新しました' : '記録しました') + (state.books.length > 1 ? `（${bookName(e.book)}）` : ''));
}

/* ========== CSV ========== */
function toCsv() {
  const head = ['日付', '種別', 'カテゴリ', '金額', 'メモ', '帳簿'];
  const q = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const rows = [...state.entries].sort((a, b) => a.date.localeCompare(b.date))
    .map(e => [e.date, e.type === 'income' ? '収入' : '支出', e.category, e.amount, e.memo || '', bookName(e.book)].map(q).join(','));
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
  const list = [];
  for (const [date, type, category, amount, memo, bookCol] of rows) {
    const amt = parseInt(String(amount).replace(/[^\d]/g, ''), 10);
    const d = String(date).trim().replace(/\//g, '-').replace(/-(\d)(?=-|$)/g, '-0$1');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !amt) continue;
    const t = type === '収入' ? 'income' : 'expense';
    // 帳簿列がない古いCSVは、いま開いている帳簿に入れる
    const bk = (state.books.find(b => b.name === String(bookCol || '').trim()) || { id: state.book }).id;
    const cat = (category || 'その他').trim();
    const cats = catsOf(bk);
    if (!cats[t].includes(cat)) cats[t].push(cat);
    list.push({ id: uid(), createdAt: Date.now(), book: bk, date: d, type: t, category: cat, amount: amt, memo: (memo || '').trim() });
  }
  if (!list.length) { toast('読み込める行がありませんでした'); return; }
  // 同じ内容の記録は重複させない
  const key = e => [e.book, e.date, e.type, e.category, e.amount, e.memo].join('|');
  const have = new Set(state.entries.map(key));
  const fresh = list.filter(e => !have.has(key(e)));
  await db.putMany(fresh);
  await db.setMeta('catsByBook', state.catsByBook);
  state.entries.push(...fresh);
  render(); renderSettings();
  toast(`${fresh.length}件を読み込みました` + (list.length > fresh.length ? `（重複${list.length - fresh.length}件はスキップ）` : ''));
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
    const [entries, books, current, catsByBook, budgetByBook, oldCats, oldBudget] = await Promise.all([
      db.all(), db.getMeta('books'), db.getMeta('currentBook'),
      db.getMeta('catsByBook'), db.getMeta('budgetByBook'), db.getMeta('cats'), db.getMeta('budget'),
    ]);
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
