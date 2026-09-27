'use strict';

const $ = sel => document.querySelector(sel);
const STATUS_TEXT = {
  parsing: '解析校验中', validated: '待上送', uploading: '上送中',
  upload_paused: '上送中断', done: '已完成', partial: '部分完成', parse_failed: '解析失败',
};
const STATUS_CLS = {
  parsing: 'parsing', validated: 'validated', uploading: 'uploading',
  upload_paused: 'upload_paused', done: 'done', partial: 'partial', parse_failed: 'parse_failed',
};
const ROW_STATUS_TEXT = { invalid: '校验异常', valid: '待上送', sent: '已上送', platform_failed: '平台拒收' };
const RUNNING = ['parsing', 'uploading'];
const TODO = ['validated', 'upload_paused', 'partial'];

let batches = [];
let tasks = [];
let listTab = 'all';
let detailId = null;
let detailTask = null;
let rowFilter = 'all';
let rowPage = 1;
let rowTotal = 0;
const PAGE_SIZE = 50;
let listTimer = null, detailTimer = null;
let pickedFile = null;
let parentTaskId = null;

// ---------- 工具 ----------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' error' : '');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => { t.className = 'toast'; }, 2600);
}
async function api(url, opts) {
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || '请求失败');
  return data;
}

// ---------- 初始化 ----------
async function init() {
  batches = await api('/api/batches');
  $('#batchSelect').innerHTML = batches.map(b => `<option value="${b.code}">${esc(b.name)}（${b.code}）</option>`).join('');
  bindEvents();
  route();
  window.addEventListener('hashchange', route);
  setInterval(refreshCurrent, 3000);
}

function bindEvents() {
  const dz = $('#dropzone');
  dz.addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', e => { pickedFile = e.target.files[0] || null; renderFileLabel(); });
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) { pickedFile = f; $('#fileInput').files = e.dataTransfer.files; renderFileLabel(); }
  });
  $('#tplLink').addEventListener('click', () => {
    const b = batches.find(x => x.code === $('#batchSelect').value);
    window.open('/api/template?batchName=' + encodeURIComponent(b ? b.name : ''), '_blank');
  });
  $('#sampleLink').addEventListener('click', () => {
    window.open('/api/sample?count=50000&batchCode=' + encodeURIComponent($('#batchSelect').value), '_blank');
  });
  $('#parentLink').addEventListener('click', () => { location.hash = '#/task/' + parentTaskId; });
  $('#cancelParent').addEventListener('click', () => setParent(null));

  $('#listTabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    listTab = btn.dataset.tab;
    document.querySelectorAll('#listTabs .tab').forEach(t => t.classList.toggle('active', t === btn));
    renderTaskTable();
  });

  $('#backLink').addEventListener('click', () => { location.hash = '#/'; });

  $('#rowTabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    rowFilter = btn.dataset.filter;
    rowPage = 1;
    document.querySelectorAll('#rowTabs .tab').forEach(t => t.classList.toggle('active', t === btn));
    loadRows();
  });
  $('#prevPage').addEventListener('click', () => { if (rowPage > 1) { rowPage--; loadRows(); } });
  $('#nextPage').addEventListener('click', () => { if (rowPage * PAGE_SIZE < rowTotal) { rowPage++; loadRows(); } });
}

function renderFileLabel() {
  $('#fileLabel').innerHTML = pickedFile
    ? `<span class="fname">${esc(pickedFile.name)}</span>（${(pickedFile.size / 1024 / 1024).toFixed(2)} MB）<br><br>
       <button class="btn-primary" id="uploadBtn">开始上传并校验</button>`
    : '';
  const btn = $('#uploadBtn');
  if (btn) btn.addEventListener('click', doUpload);
}

// ---------- 路由：hash 驱动，刷新可恢复 ----------
function route() {
  const h = location.hash || '#/';
  const tm = h.match(/^#\/task\/(\d+)/);
  if (tm) {
    detailId = parseInt(tm[1], 10);
    showDetail();
    return;
  }
  detailId = null;
  const re = h.match(/[#&?]re=(\d+)/);
  if (re) setParent(parseInt(re[1], 10));
  showList();
}

function showList() {
  $('#listView').style.display = '';
  $('#detailView').style.display = 'none';
  loadTasks();
}
async function showDetail() {
  $('#listView').style.display = 'none';
  $('#detailView').style.display = '';
  await refreshDetail();
}

async function refreshCurrent() {
  if (detailId) await refreshDetail();
  else await loadTasks(true);
}

// ---------- 上传 ----------
async function doUpload() {
  if (!pickedFile) return toast('请先选择文件', true);
  const batchCode = $('#batchSelect').value;
  if (!batchCode) return toast('请选择考试批次', true);
  const fd = new FormData();
  fd.append('file', pickedFile);
  fd.append('batchCode', batchCode);
  fd.append('name', $('#taskName').value.trim());
  if (parentTaskId) fd.append('parentTaskId', parentTaskId);

  const btn = $('#uploadBtn');
  btn.disabled = true;
  btn.textContent = '上传中（0%）…';
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/tasks');
    const task = await new Promise((resolve, reject) => {
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) btn.textContent = `上传中（${(e.loaded / e.total * 100).toFixed(0)}%）…`;
      };
      xhr.onload = () => {
        try {
          const d = JSON.parse(xhr.responseText);
          xhr.status >= 200 && xhr.status < 300 ? resolve(d) : reject(new Error(d.error || '上传失败'));
        } catch (e) { reject(new Error('上传失败')); }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(fd);
    });
    toast('上传成功，后台正在校验…');
    pickedFile = null;
    $('#fileInput').value = '';
    $('#taskName').value = '';
    renderFileLabel();
    setParent(null);
    location.hash = '#/task/' + task.id;
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = '开始上传并校验';
  }
}

// ---------- 任务列表 ----------
async function loadTasks(silent) {
  try {
    tasks = await api('/api/tasks');
  } catch (e) {
    if (!silent) toast(e.message, true);
    return;
  }
  renderTaskTable();
}

function setParent(id) {
  parentTaskId = id;
  const banner = $('#parentBanner');
  if (id) {
    banner.style.display = 'block';
    $('#parentLink').textContent = '#' + id;
  } else banner.style.display = 'none';
}

function renderTaskTable() {
  const counts = {
    running: tasks.filter(t => RUNNING.includes(t.status)).length,
    todo: tasks.filter(t => TODO.includes(t.status)).length,
    done: tasks.filter(t => t.status === 'done' || t.status === 'parse_failed').length,
  };
  $('#cnt-running').textContent = counts.running;
  $('#cnt-todo').textContent = counts.todo;
  $('#cnt-done').textContent = counts.done;

  let list = tasks;
  if (listTab === 'running') list = tasks.filter(t => RUNNING.includes(t.status));
  if (listTab === 'todo') list = tasks.filter(t => TODO.includes(t.status));
  if (listTab === 'done') list = tasks.filter(t => t.status === 'done' || t.status === 'parse_failed');

  $('#listEmpty').style.display = list.length ? 'none' : '';
  $('#taskTbody').innerHTML = list.map(t => `
    <tr>
      <td>${t.id}${t.parentTaskId ? `<div class="meta">重传自 #${t.parentTaskId}</div>` : ''}</td>
      <td style="max-width:240px"><div style="font-weight:500">${esc(t.name)}</div><div class="meta">${esc(t.fileName)}</div></td>
      <td><div>${esc(batchName(t.batchCode))}</div><div class="meta">${t.batchCode}</div></td>
      <td>${t.totalRows}</td>
      <td>${t.invalidRows > 0 ? `<span style="color:var(--red)">${t.invalidRows}</span>` : 0}</td>
      <td><span style="color:var(--green)">${t.uploadedRows}</span></td>
      <td>${t.platformFailedRows > 0 ? `<span style="color:var(--amber)">${t.platformFailedRows}</span>` : 0}</td>
      <td>${statusBadge(t.status)}</td>
      <td class="meta">${fmtTime(t.createdAt)}</td>
      <td style="white-space:nowrap">
        <button class="btn-ghost btn-sm" onclick="openTask(${t.id})">查看</button>
      </td>
    </tr>`).join('');
}

function openTask(id) { location.hash = '#/task/' + id; }
function batchName(code) { return (batches.find(b => b.code === code) || {}).name || code; }
function statusBadge(s) {
  const run = RUNNING.includes(s) ? '<span class="dot" style="background:currentColor"></span>' : '';
  return `<span class="status s-${STATUS_CLS[s] || ''}">${run}${STATUS_TEXT[s] || s}</span>`;
}

// ---------- 任务详情 ----------
async function refreshDetail() {
  try {
    detailTask = await api('/api/tasks/' + detailId);
  } catch (e) {
    toast(e.message, true);
    location.hash = '#/';
    return;
  }
  renderDetail();
  await loadRows();
}

function renderDetail() {
  const t = detailTask;
  $('#detailTitle').textContent = `任务 #${t.id} · ${t.name}`;
  $('#detailAlert').innerHTML = '';
  if (t.status === 'parse_failed') {
    $('#detailAlert').innerHTML = `<div class="alert">❌ 解析失败：${esc(t.errorMessage || '未知错误')}。请修正文件后重新上传。</div>`;
  } else if (t.status === 'upload_paused') {
    $('#detailAlert').innerHTML = `<div class="alert warn">⚠️ 上送中断：${esc(t.errorMessage || '网络/平台故障')}。已上送的进度已保留，可点"继续上送"。</div>`;
  } else if (t.errorMessage) {
    $('#detailAlert').innerHTML = `<div class="alert warn">⚠️ ${esc(t.errorMessage)}</div>`;
  }

  const pending = Math.max(t.validRows - t.uploadedRows, 0);
  const stats = [
    ['total', t.totalRows, '文件总行数'],
    ['', t.validRows, '校验通过'],
    ['invalid', t.invalidRows, '校验异常'],
    ['sent', t.uploadedRows, '已上送成功'],
    ['pf', t.platformFailedRows, '市级平台拒收'],
  ];
  $('#stats').innerHTML = stats.map(([c, n, l]) =>
    `<div class="stat ${c}"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join('');

  const denom = Math.max(t.validRows, 1);
  const pct = Math.min(100, t.uploadedRows / denom * 100);
  const bar = $('#progressBar');
  bar.className = 'progress' + (t.status === 'partial' ? ' partial' : '');
  bar.firstElementChild.style.width = (['parsing', 'validated', 'parse_failed'].includes(t.status) ? 0 : pct) + '%';

  let meta = `源文件：<b>${esc(t.fileName)}</b><br>考试批次：<b>${esc(batchName(t.batchCode))}</b>（${t.batchCode}）<br>` +
    `创建：<b>${fmtTime(t.createdAt)}</b>　最近更新：<b>${fmtTime(t.updatedAt)}</b>`;
  if (t.parentTaskId) meta += `<br>🔁 本任务是任务 <b>#${t.parentTaskId}</b> 异常行修正后的重传任务`;
  $('#detailMeta').innerHTML = meta;

  if (t.status === 'uploading' || t.status === 'parsing') {
    $('#progressMeta').innerHTML = t.status === 'parsing'
      ? `正在解析与校验（已处理 ${t.totalRows} 行，异常 ${t.invalidRows} 行）…`
      : `正在分批上送市级平台：已成功 ${t.uploadedRows} / ${t.validRows} 行（${pct.toFixed(1)}%），平台拒收 ${t.platformFailedRows} 行…`;
  } else {
    $('#progressMeta').innerHTML = t.validRows
      ? `上送进度：${t.uploadedRows} / ${t.validRows} 行（${pct.toFixed(1)}%）`
      : '校验未通过任何行，暂无可上送数据';
  }

  // 操作按钮
  const acts = [];
  if (['validated', 'upload_paused', 'partial'].includes(t.status)) {
    const remain = t.validRows - t.uploadedRows;
    acts.push(`<button class="btn-primary" onclick="startSend()">${t.status === 'validated' ? '🚀 开始分批上送' : '▶️ 继续上送'}（剩余 ${remain} 行）</button>`);
  }
  if (t.status === 'uploading') acts.push(`<button class="btn-ghost" disabled>上送中，请稍候…</button>`);

  const errCount = t.invalidRows + t.platformFailedRows;
  if (errCount > 0 && t.status !== 'parsing' && t.status !== 'parse_failed') {
    const parts = [];
    if (t.invalidRows) parts.push(`校验异常 ${t.invalidRows}`);
    if (t.platformFailedRows) parts.push(`平台拒收 ${t.platformFailedRows}`);
    acts.push(`<a class="btn-ghost" style="text-decoration:none;display:inline-block"
      href="/api/tasks/${t.id}/errors">⬇️ 下载异常行（${parts.join('、')}）</a>`);
    acts.push(`<button class="btn-primary" style="background:var(--purple)" onclick="reupload()">🔁 下载并修正后重传</button>`);
  }
  if (!RUNNING.includes(t.status)) {
    acts.push(`<button class="btn-danger" onclick="removeTask()">删除任务</button>`);
  }
  $('#detailActions').innerHTML = acts.join('');

  // 行筛选 tab 角标
  const badges = {
    all: t.totalRows, invalid: t.invalidRows,
    valid: t.validRows - t.uploadedRows - t.platformFailedRows,
    sent: t.uploadedRows, platform_failed: t.platformFailedRows,
  };
  document.querySelectorAll('#rowTabs .tab').forEach(tab => {
    const n = badges[tab.dataset.filter] || 0;
    tab.innerHTML = ({ all: '全部', invalid: '校验异常', valid: '待上送', sent: '已上送', platform_failed: '平台拒收' })[tab.dataset.filter]
      + ` <span class="badge">${n}</span>`;
  });
}

async function startSend() {
  try {
    await api(`/api/tasks/${detailId}/send`, { method: 'POST' });
    toast('已开始分批上送');
    refreshDetail();
  } catch (e) { toast(e.message, true); }
}

function reupload() {
  if (!confirm('将先下载异常行文件。请在 Excel 中：\n1. 按"异常原因"列修正前 4 列数据；\n2. 保存后回到本页上传（已自动关联原任务 #' + detailId + '）。\n\n是否现在下载？')) return;
  window.open('/api/tasks/' + detailId + '/errors', '_blank');
  setTimeout(() => {
    location.hash = '#/?re=' + detailId;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, 800);
}

async function removeTask() {
  if (!confirm('确定删除该任务及其全部明细？此操作不可恢复。')) return;
  try {
    await api('/api/tasks/' + detailId, { method: 'DELETE' });
    toast('任务已删除');
    location.hash = '#/';
  } catch (e) { toast(e.message, true); }
}

// ---------- 明细 ----------
async function loadRows() {
  if (!detailId) return;
  let data;
  try {
    data = await api(`/api/tasks/${detailId}/rows?filter=${rowFilter}&page=${rowPage}&size=${PAGE_SIZE}`);
  } catch (e) { return; }
  rowTotal = data.total;
  $('#rowTbody').innerHTML = data.rows.map(r => {
    let reason = '';
    if (r.status === 'invalid') reason = r.errors.map(e => `<div class="err-text">• ${esc(e)}</div>`).join('');
    else if (r.status === 'platform_failed') reason = `<div class="err-text">${esc(r.platformReason)}</div>`;
    return `<tr>
      <td>${r.lineNo}</td>
      <td>${esc(r.studentNo)}</td>
      <td>${esc(r.courseName)}</td>
      <td>${esc(r.score)}</td>
      <td style="max-width:260px">${esc(r.batchName)}</td>
      <td><span class="status s-${STATUS_CLS[r.status] || ''}" style="background:#f1f5f9;color:#475569">${ROW_STATUS_TEXT[r.status] || r.status}</span></td>
      <td>${reason}</td>
    </tr>`;
  }).join('');
  $('#rowEmpty').style.display = rowTotal ? 'none' : '';
  const pages = Math.max(Math.ceil(rowTotal / PAGE_SIZE), 1);
  $('#pageInfo').textContent = `第 ${rowPage} / ${pages} 页，共 ${rowTotal} 行`;
  $('#prevPage').disabled = rowPage <= 1;
  $('#nextPage').disabled = rowPage >= pages;
}

init().catch(e => toast(e.message, true));
