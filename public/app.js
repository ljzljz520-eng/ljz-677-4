'use strict';
/* 成绩导入单页：hash 路由；所有状态来自服务端，刷新/重开浏览器均可恢复 */

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');
const reuploadInput = document.getElementById('reuploadInput');
const ACTIVE = new Set(['processing', 'submitting']);

let pollTimer = null;
let metaCache = null;

function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.className = 'toast'), 2600);
}

async function api(path, options) {
  const res = await fetch('/api' + path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `请求失败（${res.status}）`);
  }
  return res.json();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusBadge(status, text) {
  return `<span class="badge ${status}">${ACTIVE.has(status) ? '<span class="dot live"></span>' : ''}${esc(text || status)}</span>`;
}

function taskProgress(t) {
  if (t.status === 'processing') {
    if (!t.totalRows) return '<div class="progress"><div style="width:3%"></div></div><span class="muted">正在读取文件…</span>';
    return `<div class="progress"><div style="width:${Math.min(95, t.totalRows / 300)}%"></div></div><span class="muted">已解析 ${t.totalRows} 行：通过 ${t.validRows} · 异常 ${t.invalidRows}</span>`;
  }
  if (['submitting', 'completed', 'failed', 'ready'].includes(t.status) && t.totalBatches > 0) {
    const pct = t.totalBatches ? Math.round((t.doneBatches / t.totalBatches) * 100) : 0;
    return `<div class="progress ${t.status === 'completed' ? 'green' : ''}"><div style="width:${pct}%"></div></div><span class="muted">批次 ${t.doneBatches}/${t.totalBatches} · 已上送 ${t.submittedRows} · 拒收 ${t.rejectedRows}</span>`;
  }
  return `<span class="muted">通过 ${t.validRows} · 校验异常 ${t.invalidRows}</span>`;
}

/* ---------------- 轮询调度 ---------------- */
function ensurePolling(tasksOrTask) {
  const hasActive = Array.isArray(tasksOrTask)
    ? tasksOrTask.some((t) => ACTIVE.has(t.status))
    : ACTIVE.has(tasksOrTask.status);
  if (hasActive) {
    if (!pollTimer) pollTimer = setTimeout(() => renderRoute({ keepScroll: true }), 1500);
  } else {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }
}

/* ---------------- 列表页 ---------------- */
async function renderList() {
  nav.innerHTML = '<a href="#/">任务列表</a>';
  let meta = metaCache || await api('/meta').catch(() => null);
  if (meta) metaCache = meta;

  const tasks = await api('/tasks');
  app.innerHTML = `
    <div class="card">
      <h2>① 上传成绩大表 <span class="sub">支持 .csv / .xlsx，单次可达数万行，文件仅在本机处理</span></h2>
      <div class="upload-zone" id="dropZone">
        <div class="icon">⬆️</div>
        <p>将成绩表拖到此处，或 <strong>点击选择文件</strong></p>
        <div class="upload-actions">
          <button class="btn-primary" id="pickBtn">选择文件上传</button>
          <a class="btn" href="/api/template.csv" download>下载导入模板</a>
        </div>
      </div>
      <p class="muted" style="margin-top:10px;font-size:12px;">表头：学号、姓名、课程代码、分数、考试批次。处理流程：行级校验 → 校验通过行分批（每批 500 行）上送市级平台 → 异常行可下载修改后重传。</p>
    </div>

    <div class="card">
      <h2>② 校验规则 <span class="sub">区县级基础数据（数据如下为演示环境模拟数据）</span></h2>
      <div class="rules">
        <div>
          <div class="rule-title">学号</div>
          <ul>
            <li>必填，<code>10 位数字</code>（如 2026000001）</li>
            <li>必须存在于学生名册（名册 ${meta ? meta.studentCount : '-'} 人）</li>
            <li>同一文件内 学号+课程+批次 不得重复</li>
          </ul>
        </div>
        <div>
          <div class="rule-title">课程代码</div>
          <ul>${(meta ? meta.courses : []).slice(0, 6).map((c) => `<li><code>${esc(c.code)}</code> ${esc(c.name)}（满分 ${c.fullScore}）</li>`).join('')}<li class="muted">等 ${meta ? meta.courses.length : 0} 门课程</li></ul>
        </div>
        <div>
          <div class="rule-title">分数</div>
          <ul><li>必填，为数字，<code>0 ~ 课程满分</code></li><li>最多保留 1 位小数</li></ul>
        </div>
        <div>
          <div class="rule-title">考试批次</div>
          <ul>${(meta ? meta.examBatches : []).map((b) => `<li><code>${esc(b.code)}</code> ${esc(b.name)} · ${b.status === 'open' ? '开放报送' : '已关闭'}</li>`).join('')}</ul>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>③ 导入任务 <span class="sub">历史任务保存在服务端，关闭页面或刷新后仍可查看；处理中的任务进度实时刷新</span></h2>
      ${tasks.length === 0 ? '<div class="empty">暂无任务，上传一个成绩表开始吧</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>任务编号</th><th>文件名</th><th>状态</th><th style="min-width:260px">进度</th><th>创建时间</th><th></th></tr></thead>
        <tbody>
          ${tasks.map((t) => `
          <tr>
            <td class="mono">${esc(t.id)}</td>
            <td>${esc(t.filename)}${t.parentTaskId ? `<br><span class="muted" style="font-size:11px">重传自 ${esc(t.parentTaskId)}</span>` : ''}</td>
            <td>${statusBadge(t.status, t.statusText)}</td>
            <td>${taskProgress(t)}${t.error ? `<div class="err-text" style="font-size:12px">${esc(t.error)}</div>` : ''}</td>
            <td class="muted">${fmtTime(t.createdAt)}</td>
            <td class="right"><a class="btn btn-sm" href="#/task/${t.id}">查看</a></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`}
    </div>`;

  // 上传交互
  const zone = document.getElementById('dropZone');
  const pick = document.getElementById('pickBtn');
  const openPicker = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.xlsx,.xls';
    input.onchange = () => input.files[0] && uploadFile(input.files[0], null);
    input.click();
  };
  zone.onclick = openPicker;
  pick.onclick = (e) => { e.stopPropagation(); openPicker(); };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('dragover'); };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0], null);
  };

  ensurePolling(tasks);
}

async function uploadFile(file, parentTaskId) {
  const fd = new FormData();
  fd.append('file', file);
  if (parentTaskId) fd.append('parentTaskId', parentTaskId);
  toast('正在上传 ' + file.name + ' …');
  try {
    const t = await api('/tasks', { method: 'POST', body: fd });
    toast('上传成功，任务 ' + t.id + ' 正在解析校验');
    location.hash = '#/task/' + t.id;
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------- 详情页 ---------------- */
const detailState = { tab: 'problems', page: 1 };

async function renderDetail(id) {
  nav.innerHTML = `<a href="#/">← 返回任务列表</a>`;
  let t;
  try {
    t = await api('/tasks/' + id);
  } catch (e) {
    app.innerHTML = `<div class="card empty">${esc(e.message)}<br><br><a class="btn" href="#/">返回列表</a></div>`;
    return;
  }
  const active = ACTIVE.has(t.status);

  app.innerHTML = `
    <div class="card">
      <div class="detail-head">
        <div>
          <h2>${esc(t.filename)} ${statusBadge(t.status, t.statusText)}</h2>
          <div class="meta">
            <span>任务号 <b class="mono">${esc(t.id)}</b></span>
            <span>创建 ${fmtTime(t.createdAt)}</span>
            <span>更新 ${fmtTime(t.updatedAt)}</span>
            ${t.parentTaskId ? `<span>重传自 <b class="mono">${esc(t.parentTaskId)}</b></span>` : ''}
          </div>
          ${t.error ? `<div class="err-text" style="margin-top:8px">⚠ ${esc(t.error)}</div>` : ''}
        </div>
        <div class="detail-actions">
          ${t.status === 'ready' && t.validRows > 0 ? '<button class="btn-primary" id="btnSubmit">▶ 分批上送市级平台</button>' : ''}
          ${t.status === 'failed' ? '<button class="btn-primary" id="btnRetry">↻ 从中断处重试</button>' : ''}
          ${t.invalidRows + t.rejectedRows > 0 ? '<a class="btn btn-danger" id="dlAll" href="/api/tasks/' + t.id + '/errors.csv?source=both">⬇ 下载全部异常行</a>' : ''}
          ${t.invalidRows + t.rejectedRows > 0 ? '<button class="btn" id="btnReupload">↰ 修复后重传</button>' : ''}
        </div>
      </div>
      ${t.totalBatches > 0 || t.status === 'submitting' ? `
      <div style="margin-top:16px">
        <div class="progress ${t.status === 'completed' ? 'green' : ''}"><div style="width:${t.totalBatches ? Math.round(t.doneBatches / t.totalBatches * 100) : 0}%"></div></div>
        <span class="muted">批次 ${t.doneBatches}/${t.totalBatches}（每批 ${t.batchSize} 行）</span>
      </div>` : ''}
    </div>

    <div class="stats">
      <div class="stat info"><div class="num">${t.totalRows}</div><div class="label">总行数</div></div>
      <div class="stat ok"><div class="num">${t.validRows}</div><div class="label">校验通过</div></div>
      <div class="stat bad"><div class="num">${t.invalidRows}</div><div class="label">校验异常</div></div>
      <div class="stat ok"><div class="num">${t.submittedRows}</div><div class="label">平台已接收</div></div>
      <div class="stat warn"><div class="num">${t.rejectedRows}</div><div class="label">平台拒收</div></div>
    </div>

    <div class="card">
      <div class="tabs">
        <button data-tab="problems" class="${detailState.tab === 'problems' ? 'active' : ''}">异常行（${t.invalidRows + t.rejectedRows}）</button>
        <button data-tab="invalid" class="${detailState.tab === 'invalid' ? 'active' : ''}">校验异常（${t.invalidRows}）</button>
        <button data-tab="rejected" class="${detailState.tab === 'rejected' ? 'active' : ''}">平台拒收（${t.rejectedRows}）</button>
        <button data-tab="all" class="${detailState.tab === 'all' ? 'active' : ''}">全部行</button>
        <button data-tab="batches" class="${detailState.tab === 'batches' ? 'active' : ''}">上送批次（${t.totalBatches}）</button>
      </div>
      <div id="tabBody"><div class="loading">加载中…</div></div>
    </div>`;

  document.getElementById('btnSubmit')?.addEventListener('click', async () => {
    try { await api(`/tasks/${id}/submit`, { method: 'POST' }); toast('已开始分批上送'); renderRoute(); }
    catch (e) { toast(e.message, true); }
  });
  document.getElementById('btnRetry')?.addEventListener('click', async () => {
    try { await api(`/tasks/${id}/retry`, { method: 'POST' }); toast('已从中断批次继续'); renderRoute(); }
    catch (e) { toast(e.message, true); }
  });
  document.getElementById('btnReupload')?.addEventListener('click', () => {
    reuploadInput.value = '';
    reuploadInput.onchange = () => reuploadInput.files[0] && uploadFile(reuploadInput.files[0], id);
    reuploadInput.click();
  });
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => { detailState.tab = b.dataset.tab; detailState.page = 1; renderRoute(); };
  });

  await renderTab(t);
  ensurePolling(t);
}

async function renderTab(t) {
  const body = document.getElementById('tabBody');
  if (!body) return;
  const tab = detailState.tab;

  if (tab === 'batches') {
    const batches = await api(`/tasks/${t.id}/batches`);
    body.innerHTML = batches.length === 0
      ? '<div class="empty">尚未开始上送</div>'
      : `<div class="table-wrap"><table><thead><tr><th>批次</th><th>行数</th><th>状态</th><th>尝试次数</th><th>接收</th><th>拒收</th><th>错误</th><th>更新时间</th></tr></thead><tbody>
        ${batches.map((b) => `<tr>
          <td class="mono">#${b.batchNo}</td><td>${b.rowCount}</td>
          <td>${b.status === 'done' ? '<span class="badge completed">成功</span>' : b.status === 'sending' ? '<span class="badge submitting">发送中</span>' : b.status === 'failed' ? '<span class="badge failed">失败</span>' : '<span class="badge ready">待发送</span>'}</td>
          <td>${b.attempts}</td><td>${b.accepted}</td><td>${b.rejected}</td>
          <td class="err-text">${esc(b.error || '')}</td><td class="muted">${fmtTime(b.updatedAt)}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
    return;
  }

  const statusMap = { problems: 'problem', invalid: 'invalid', rejected: 'rejected', all: 'all' };
  const url = `/tasks/${t.id}/rows?status=${statusMap[tab]}&page=${detailState.page}&size=20`;
  const data = await api(url);
  const items = data.items;

  const rowBadge = (s) => ({
    invalid: '<span class="badge failed">校验异常</span>',
    rejected: '<span class="badge ready">平台拒收</span>',
    valid: '<span class="badge ready">待上送</span>',
    submitted: '<span class="badge completed">已接收</span>',
  })[s] || s;

  const total = tab === 'problems' ? t.invalidRows + t.rejectedRows : data.total;
  body.innerHTML = data.items.length === 0
    ? `<div class="empty">${tab === 'problems' ? '🎉 没有异常行' : '暂无数据'}</div>`
    : `<div class="table-wrap"><table><thead><tr><th>行号</th><th>学号</th><th>姓名</th><th>课程</th><th>分数</th><th>考试批次</th><th>状态</th><th>原因</th></tr></thead><tbody>
      ${items.map((r) => `<tr>
        <td class="mono">${r.n}</td><td class="mono">${esc(r.studentNo)}</td><td>${esc(r.studentName)}</td>
        <td class="mono">${esc(r.courseCode)}</td><td>${esc(r.score)}</td><td class="mono">${esc(r.examBatch)}</td>
        <td>${rowBadge(r.status)}</td><td class="err-text">${esc(r.err || '')}</td>
      </tr>`).join('')}
    </tbody></table></div>
    <div class="pager">
      共 ${total} 行 · 第 ${data.page}/${data.totalPages} 页
      <button class="btn btn-sm" ${data.page <= 1 ? 'disabled' : ''} onclick="window.__prevPage()">上一页</button>
      <button class="btn btn-sm" ${data.page >= data.totalPages ? 'disabled' : ''} onclick="window.__nextPage()">下一页</button>
    </div>`;

  window.__prevPage = () => { detailState.page--; renderRoute(); };
  window.__nextPage = () => { detailState.page++; renderRoute(); };
}

/* ---------------- hash 路由 ---------------- */
let currentDetailId = null;
let lastHash = null;
function renderRoute(opts = {}) {
  const scrollY = window.scrollY;
  const hash = location.hash || '#/';
  const sameView = lastHash === hash;
  lastHash = hash;
  const m = hash.match(/^#\/task\/([\w-]+)/);
  const id = m ? m[1] : null;
  if (id !== currentDetailId) {
    currentDetailId = id;
    detailState.tab = 'problems';
    detailState.page = 1;
  }
  Promise.resolve(id ? renderDetail(id) : renderList())
    .catch((e) => {
      app.innerHTML = `<div class="card empty err-text">${esc(e.message)}<br><br><a class="btn" href="#/">返回列表</a></div>`;
    })
    .finally(() => {
      // 轮询自动刷新且视图未变时保持滚动位置，避免页面跳动
      if (opts.keepScroll && sameView) window.scrollTo(0, scrollY);
    });
}
window.addEventListener('hashchange', renderRoute);
renderRoute();
