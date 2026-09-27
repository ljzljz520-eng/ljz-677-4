const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const db = require('./db');
const { parseAndValidate } = require('./parser');
const { runTask, recoverOnStartup } = require('./worker');
const { templateBuffer, sampleBuffer, errorRowsBuffer } = require('./files');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 10) + (ext === '.csv' ? '.csv' : '.xlsx'));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('仅支持 .xlsx / .xls / .csv 文件'), ok);
  },
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const STATUS_TEXT = {
  parsing: '解析校验中', validated: '待上送', uploading: '上送中',
  upload_paused: '上送中断', done: '已完成', partial: '部分完成',
  parse_failed: '解析失败',
};

function taskRow(t) {
  return {
    id: t.id,
    name: t.name,
    fileName: t.file_name,
    batchCode: t.batch_code,
    totalRows: t.total_rows,
    validRows: t.valid_rows,
    invalidRows: t.invalid_rows,
    uploadedRows: t.uploaded_rows,
    platformFailedRows: t.platform_failed_rows,
    status: t.status,
    statusText: STATUS_TEXT[t.status] || t.status,
    errorMessage: t.error_message,
    parentTaskId: t.parent_task_id,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

// ---------- 基础数据 ----------
app.get('/api/batches', (req, res) => {
  res.json(db.prepare('SELECT code, name FROM batches WHERE active = 1 ORDER BY id').all());
});

// ---------- 下载模板 / 示例 ----------
app.get('/api/template', (req, res) => {
  const buf = templateBuffer(req.query.batchName);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('成绩导入模板.xlsx'));
  res.end(buf);
});

app.get('/api/sample', (req, res) => {
  const count = Math.min(parseInt(req.query.count, 10) || 50000, 100000);
  const batchCode = String(req.query.batchCode || '202603');
  const buf = sampleBuffer(count, batchCode);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(`成绩示例_${count}行.xlsx`));
  res.end(buf);
});

// ---------- 上传建任务 ----------
app.post('/api/tasks', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw Object.assign(new Error('未收到上传文件'), { status: 400 });
  const batchCode = String(req.body.batchCode || '');
  const batch = db.prepare('SELECT * FROM batches WHERE code = ? AND active = 1').get(batchCode);
  if (!batch) throw Object.assign(new Error('请选择有效的考试批次'), { status: 400 });
  const parentId = req.body.parentTaskId ? parseInt(req.body.parentTaskId, 10) : null;
  const now = Date.now();
  const name = String(req.body.name || '').trim() ||
    `${batch.name}-${req.file.originalname.replace(/\.(xlsx|xls|csv)$/i, '')}`.slice(0, 120);

  const info = db.prepare(`INSERT INTO tasks
    (name, file_name, stored_path, batch_code, status, parent_task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'parsing', ?, ?, ?)`)
    .run(name, req.file.originalname, req.file.path, batchCode, parentId, now, now);
  const taskId = info.lastInsertRowid;

  // 异步解析：接口立刻返回任务 id，页面轮询进度；浏览器刷新不影响后台处理
  setImmediate(() => {
    try {
      parseAndValidate(taskId, req.file.path, batchCode);
    } catch (e) {
      db.prepare(`UPDATE tasks SET status = 'parse_failed', error_message = ?, updated_at = ? WHERE id = ?`)
        .run(String(e.message || e), Date.now(), taskId);
    }
  });

  res.status(201).json(taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)));
}));

// ---------- 任务列表 / 详情 ----------
app.get('/api/tasks', (req, res) => {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 200').all().map(taskRow);
  res.json(rows);
});

app.get('/api/tasks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
  res.json(taskRow(t));
});

// ---------- 任务内明细分页 ----------
app.get('/api/tasks/:id/rows', (req, res) => {
  const id = req.params.id;
  const allowed = { invalid: 'invalid', sent: 'sent', platform_failed: 'platform_failed', valid: 'valid', all: null };
  const filterKey = allowed[req.query.filter] !== undefined ? req.query.filter : 'all';
  const filter = filterKey === 'all' ? null : filterKey;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 50, 1), 500);

  const where = filter ? 'WHERE task_id = ? AND status = ?' : 'WHERE task_id = ?';
  const params = filter ? [id, filter] : [id];
  const total = db.prepare(`SELECT COUNT(*) c FROM rows ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT line_no, student_no, course_name, score, batch_name, status, errors, platform_reason
    FROM rows ${where} ORDER BY line_no LIMIT ? OFFSET ?`)
    .all(...params, size, (page - 1) * size)
    .map(r => ({
      lineNo: r.line_no, studentNo: r.student_no, courseName: r.course_name,
      score: r.score, batchName: r.batch_name, status: r.status,
      errors: JSON.parse(r.errors), platformReason: r.platform_reason,
    }));
  res.json({ total, page, size, rows });
});

// ---------- 上送控制 ----------
app.post('/api/tasks/:id/send', wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (!['validated', 'upload_paused', 'partial'].includes(t.status) &&
      !(t.status === 'uploading')) {
    throw Object.assign(new Error(`当前状态「${STATUS_TEXT[t.status] || t.status}」不能上送`), { status: 409 });
  }
  const sendable = db.prepare(`SELECT COUNT(*) c FROM rows WHERE task_id = ?
    AND status IN ('valid','platform_failed')`).get(t.id).c;
  if (sendable === 0 && t.status !== 'uploading') {
    throw Object.assign(new Error('没有可上送的数据（全部为校验异常行），请下载异常行修正后重传'), { status: 409 });
  }
  runTask(t.id); // 内部有运行态保护，重复调用安全
  res.json({ ok: true });
}));

// ---------- 异常行下载 ----------
app.get('/api/tasks/:id/errors', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
  const buf = errorRowsBuffer(t.id);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const fname = `异常行_任务${t.id}_${t.file_name.replace(/\.(xlsx|xls|csv)$/i, '')}.xlsx`;
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fname));
  res.end(buf);
});

// ---------- 删除任务 ----------
app.delete('/api/tasks/:id', wrap(async (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (t.status === 'parsing' || t.status === 'uploading') {
    throw Object.assign(new Error('任务正在处理中，不能删除'), { status: 409 });
  }
  db.prepare('DELETE FROM rows WHERE task_id = ?').run(t.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
  try { if (t.stored_path && fs.existsSync(t.stored_path)) fs.unlinkSync(t.stored_path); } catch { /* 忽略 */ }
  res.json({ ok: true });
}));

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /文件/.test(err.message)) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

recoverOnStartup();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`成绩导入服务已启动: http://localhost:${PORT}`);
});
