'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const store = require('./store');
const ref = require('./referenceData');
const { processTaskFile } = require('./importer');
const { submitTask, retryTask, BATCH_SIZE } = require('./submitter');
const { genId, now, toCsv, HttpError } = require('./util');

const UPLOAD_DIR = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), 'uploads')
  : path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const id = genId();
      req._taskId = id;
      const ext = path.extname(file.originalname) || '.csv';
      cb(null, id + ext);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const CN_STATUS = {
  processing: '解析校验中',
  ready: '待上送',
  submitting: '分批上送中',
  completed: '已完成',
  failed: '异常中断',
};

function publicTask(t) {
  return { ...t, statusText: CN_STATUS[t.status] || t.status, batchSize: BATCH_SIZE };
}

function createRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));

  /** 基础数据 / 校验规则 */
  r.get('/meta', (req, res) => {
    res.json(ref.meta());
  });

  /** 导入模板下载 */
  r.get('/template.csv', (req, res) => {
    const csv = toCsv(['学号', '姓名', '课程代码', '分数', '考试批次'], [
      ['2026000001', ref.getStudent('2026000001') || '', 'YW', '108.5', '2026-QJ-QZ'],
      ['2026000002', ref.getStudent('2026000002') || '', 'SX', '116', '2026-QJ-QM'],
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="score-template.csv"');
    res.send(csv);
  });

  /** 上传成绩表，创建导入任务（解析校验异步进行） */
  r.post('/tasks', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, '未收到上传文件');
    const id = req._taskId;
    const task = {
      id,
      filename: req.file.originalname,
      storedPath: req.file.path,
      parentTaskId: (req.body && req.body.parentTaskId) || null,
      status: 'processing',
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      submittedRows: 0,
      rejectedRows: 0,
      totalBatches: 0,
      doneBatches: 0,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    };
    store.saveTask(task);
    res.status(202).json(publicTask(task));
    // 异步解析，不阻塞响应
    processTaskFile(id);
  }));

  /** 任务列表（浏览器刷新后恢复历史任务） */
  r.get('/tasks', (req, res) => {
    res.json(store.listTasks().map(publicTask));
  });

  /** 任务详情 */
  r.get('/tasks/:id', wrap(async (req, res) => {
    const t = store.getTask(req.params.id);
    if (!t) throw new HttpError(404, '任务不存在');
    res.json(publicTask(t));
  }));

  /** 行数据分页（按状态过滤） */
  r.get('/tasks/:id/rows', wrap(async (req, res) => {
    const t = store.getTask(req.params.id);
    if (!t) throw new HttpError(404, '任务不存在');
    const { status = 'all' } = req.query;
    let page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(req.query.size, 10) || 20));
    let rows = store.getRows(t.id);
    if (status === 'problem') rows = rows.filter((x) => x.status === 'invalid' || x.status === 'rejected');
    else if (status !== 'all') rows = rows.filter((x) => x.status === status);
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    page = Math.min(page, totalPages);
    const items = rows.slice((page - 1) * size, page * size);
    res.json({ page, size, total, totalPages, items });
  }));

  /** 批次记录 */
  r.get('/tasks/:id/batches', wrap(async (req, res) => {
    const t = store.getTask(req.params.id);
    if (!t) throw new HttpError(404, '任务不存在');
    res.json(store.getBatches(t.id).slice().sort((a, b) => a.batchNo - b.batchNo));
  }));

  /** 开始/继续上送市级平台 */
  r.post('/tasks/:id/submit', wrap(async (req, res) => {
    const t = store.getTask(req.params.id);
    if (!t) throw new HttpError(404, '任务不存在');
    submitTask(t.id).catch((e) => console.error('[submit]', e.message));
    res.json({ ok: true, message: t.status === 'submitting' ? '任务正在上送中' : '已开始分批上送' });
  }));

  /** 失败重试（断点续传） */
  r.post('/tasks/:id/retry', wrap(async (req, res) => {
    const t = store.getTask(req.params.id);
    if (!t) throw new HttpError(404, '任务不存在');
    await retryTask(t.id);
    res.json({ ok: true, message: '已从中断批次继续上送' });
  }));

  /** 下载异常行（校验异常 / 平台拒收 / 全部），文件可直接修改后重传 */
  r.get('/tasks/:id/errors.csv', wrap(async (req, res) => {
    const t = store.getTask(req.params.id);
    if (!t) throw new HttpError(404, '任务不存在');
    const source = req.query.source || 'both';
    const rows = store.getRows(t.id).filter((x) => {
      if (source === 'invalid') return x.status === 'invalid';
      if (source === 'rejected') return x.status === 'rejected';
      return x.status === 'invalid' || x.status === 'rejected';
    });
    const csv = toCsv(
      ['学号', '姓名', '课程代码', '分数', '考试批次', '错误原因'],
      rows.map((x) => [x.studentNo, x.studentName, x.courseCode, x.score, x.examBatch, x.err])
    );
    const tag = source === 'invalid' ? '校验异常' : source === 'rejected' ? '平台拒收' : '异常行';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(t.id + '_' + tag + '.csv')}`);
    res.send(csv);
  }));

  return r;
}

module.exports = { createRouter };
