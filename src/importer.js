'use strict';
/**
 * 文件解析 + 校验 + 入库
 * 支持 .csv / .xlsx；表头支持中英文；自动忽略"错误原因"列（便于异常行下载后直接改数重传）
 */
const fs = require('fs');
const { Readable } = require('stream');
const { parse } = require('csv-parse');
const xlsx = require('xlsx');
const iconv = require('iconv-lite');
const store = require('./store');
const { validateRow } = require('./validator');
const { now, yieldLoop } = require('./util');

const HEADER_MAP = new Map([
  ['学号', 'studentNo'], ['student_no', 'studentNo'], ['studentno', 'studentNo'], ['student id', 'studentNo'],
  ['姓名', 'studentName'], ['student_name', 'studentName'], ['name', 'studentName'], ['学生姓名', 'studentName'],
  ['课程代码', 'courseCode'], ['课程', 'courseCode'], ['course_code', 'courseCode'], ['coursecode', 'courseCode'], ['course', 'courseCode'],
  ['分数', 'score'], ['成绩', 'score'], ['score', 'score'],
  ['考试批次', 'examBatch'], ['批次', 'examBatch'], ['exam_batch', 'examBatch'], ['exambatch', 'examBatch'], ['batch', 'examBatch'],
  // 重传文件中可能存在的列 -> 忽略
  ['错误原因', null], ['error', null], ['error_msg', null], ['行号', null], ['row_no', null],
]);

function mapHeader(headerRow) {
  const mapping = []; // index -> field|null|'?'(未知)
  const found = new Set();
  for (const raw of headerRow) {
    const key = String(raw ?? '').trim().toLowerCase();
    if (HEADER_MAP.has(key)) {
      const field = HEADER_MAP.get(key);
      mapping.push(field);
      if (field) found.add(field);
    } else {
      mapping.push('?');
    }
  }
  const required = ['studentNo', 'courseCode', 'score', 'examBatch'];
  const missing = required.filter((f) => !found.has(f));
  if (missing.length) {
    const cn = { studentNo: '学号', courseCode: '课程代码', score: '分数', examBatch: '考试批次' };
    throw new Error(`表头缺少必需列：${missing.map((m) => cn[m]).join('、')}（支持表头：学号,姓名,课程代码,分数,考试批次）`);
  }
  return mapping;
}

function rowFromArray(arr, mapping) {
  const row = { studentNo: '', studentName: '', courseCode: '', score: '', examBatch: '' };
  for (let i = 0; i < mapping.length; i++) {
    const f = mapping[i];
    if (f && f !== '?') row[f] = String(arr[i] ?? '').trim();
  }
  return row;
}

/** 读取 CSV：UTF-8 BOM/UTF-8 直接读；探测到 U+FFFD 判定为 GBK 转码（兼容 Excel"CSV(逗号分隔)"导出） */
function readCsvStream(filePath) {
  let buf = fs.readFileSync(filePath);
  let encoding = 'utf8';
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  } else if (buf.toString('utf8', 0, Math.min(buf.length, 8192)).includes('�')) {
    buf = Buffer.from(iconv.decode(buf, 'gbk'), 'utf8');
    encoding = 'gbk';
  }
  const stream = Readable.from(buf);
  stream.encoding = encoding;
  return stream.pipe(parse({ bom: true, relax_column_count: true, skip_empty_lines: true, trim: true }));
}

async function* iterateCsv(filePath) {
  const parser = readCsvStream(filePath);
  for await (const record of parser) yield record;
}

async function* iterateXlsx(filePath) {
  const wb = xlsx.readFile(filePath, { dense: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return;
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  for (const r of rows) {
    if (Array.isArray(r) && r.some((c) => String(c).trim() !== '')) yield r;
  }
}

/**
 * 解析并校验任务文件（异步执行，期间周期性让出事件循环并落盘进度）
 */
async function processTaskFile(taskId) {
  const task = store.getTask(taskId);
  if (!task) return;
  const t0 = Date.now();
  try {
    const isXlsx = /\.xlsx?$/i.test(task.filename || '');
    const iterator = isXlsx ? iterateXlsx(task.storedPath) : iterateCsv(task.storedPath);

    let mapping = null;
    let rowNo = 0;
    const rows = [];
    const seenKeys = new Set();
    let valid = 0;
    let invalid = 0;

    for await (const record of iterator) {
      rowNo++;
      if (rowNo === 1) {
        mapping = mapHeader(record);
        continue;
      }
      const r = rowFromArray(record, mapping);
      const err = validateRow(r, seenKeys);
      rows.push({
        n: rowNo - 1, // 数据行号（不含表头）
        studentNo: r.studentNo,
        studentName: r.studentName,
        courseCode: r.courseCode,
        score: r.score,
        examBatch: r.examBatch,
        status: err ? 'invalid' : 'valid',
        err,
        bn: null, // 上送批次号
      });
      err ? invalid++ : valid++;

      if (rows.length % 2000 === 0) {
        task.totalRows = rows.length;
        task.validRows = valid;
        task.invalidRows = invalid;
        task.updatedAt = now();
        store.saveTask(task);
        await yieldLoop();
      }
    }

    store.setRows(taskId, rows);
    Object.assign(task, {
      status: 'ready',
      totalRows: rows.length,
      validRows: valid,
      invalidRows: invalid,
      submittedRows: 0,
      rejectedRows: 0,
      totalBatches: 0,
      doneBatches: 0,
      error: null,
      updatedAt: now(),
    });
    store.saveTask(task);
    store.flush();
    console.log(`[importer] task ${taskId} parsed ${rows.length} rows (valid=${valid}, invalid=${invalid}) in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`[importer] task ${taskId} failed:`, e.message);
    Object.assign(task, { status: 'failed', error: '文件解析失败：' + e.message, updatedAt: now() });
    store.saveTask(task);
    store.flush();
  }
}

module.exports = { processTaskFile };
