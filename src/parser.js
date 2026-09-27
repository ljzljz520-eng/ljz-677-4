const fs = require('fs');
const XLSX = require('xlsx');
const iconv = require('iconv-lite');
const db = require('./db');

const HEADER_MAP = {
  '学号': 'student_no', '学生学号': 'student_no', '考号': 'student_no',
  '课程': 'course_name', '科目': 'course_name', '课程名称': 'course_name', '科目名称': 'course_name',
  '分数': 'score', '成绩': 'score', '得分': 'score',
  '考试批次': 'batch_name', '批次': 'batch_name', '考试名称': 'batch_name',
};

function readWorkbook(filePath) {
  const buf = fs.readFileSync(filePath);
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.csv')) {
    // 兼容 Excel 导出的 GBK/GB18030 中文 CSV
    let text;
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      text = buf.toString('utf8', 3);
    } else {
      // 严格 UTF-8 解码：GBK 编码的中文基本都会产生非法 UTF-8 字节序列
      let isUtf8 = true;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        isUtf8 = false;
      }
      text = isUtf8 ? buf.toString('utf8') : iconv.decode(buf, 'gb18030');
    }
    return XLSX.read(text, { type: 'string' });
  }
  // raw:false 取格式化文本，避免 0001 学号被当成数字丢掉前导零
  return XLSX.read(buf, { type: 'buffer', raw: false });
}

function buildLookups(batchCode) {
  const studentMap = new Map();
  for (const s of db.prepare('SELECT student_no FROM students').all()) studentMap.set(s.student_no, true);

  const courseMap = new Map();
  for (const c of db.prepare('SELECT code, name, aliases FROM courses').all()) {
    courseMap.set(c.name, c.name);
    courseMap.set(c.code, c.name);
    for (const a of JSON.parse(c.aliases)) courseMap.set(a, c.name);
  }

  const batches = db.prepare('SELECT code, name FROM batches WHERE active = 1').all();
  const batchByName = new Map(batches.map(b => [b.name, b]));
  const selected = batches.find(b => b.code === batchCode);

  return { studentMap, courseMap, batchByName, selected };
}

/**
 * 解析 + 校验导入文件，结果写入 rows 表。
 * @returns {{total:number, valid:number, invalid:number}}
 */
function parseAndValidate(taskId, filePath, batchCode) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const { studentMap, courseMap, batchByName, selected } = buildLookups(batchCode);

  db.prepare('DELETE FROM rows WHERE task_id = ?').run(taskId);

  const wb = readWorkbook(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('文件中没有工作表');
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  if (aoa.length < 2) throw new Error('文件没有数据行（至少需要表头 + 1 行数据）');

  const headerRow = aoa[0].map(h => String(h).trim());
  const colIdx = {};
  headerRow.forEach((h, i) => {
    const key = HEADER_MAP[h];
    if (key && colIdx[key] === undefined) colIdx[key] = i;
  });
  const missing = ['student_no', 'course_name', 'score', 'batch_name'].filter(k => colIdx[k] === undefined);
  if (missing.length) {
    throw new Error('缺少必要列：' + missing.map(m => ({
      student_no: '学号', course_name: '课程', score: '分数', batch_name: '考试批次',
    })[m]).join('、'));
  }

  const insert = db.prepare(
    `INSERT INTO rows (task_id, line_no, student_no, course_name, score, batch_name, status, errors, platform_reason)
     VALUES (@task_id, @line_no, @student_no, @course_name, @score, @batch_name, @status, @errors, NULL)`
  );

  let total = 0, valid = 0, invalid = 0;
  const seen = new Set();
  const BATCH = 1000;
  let pending = [];

  const flush = db.transaction((items) => {
    for (const it of items) insert.run(it);
  });

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    const rawStudent = String(row[colIdx.student_no] ?? '').trim();
    const rawCourse = String(row[colIdx.course_name] ?? '').trim();
    const rawScore = String(row[colIdx.score] ?? '').trim();
    const rawBatch = String(row[colIdx.batch_name] ?? '').trim();

    if (!rawStudent && !rawCourse && !rawScore && !rawBatch) continue; // 跳过整行空白

    total++;
    const errors = [];

    if (!rawStudent) errors.push('学号不能为空');
    else if (!/^\d{10}$/.test(rawStudent)) errors.push('学号格式错误（应为10位数字）');
    else if (!studentMap.has(rawStudent)) errors.push('学号不存在，未在本校学籍库中登记');

    let courseName = '';
    if (!rawCourse) errors.push('课程不能为空');
    else {
      courseName = courseMap.get(rawCourse) || courseMap.get(rawCourse.toUpperCase());
      if (!courseName) errors.push(`课程「${rawCourse}」不存在`);
    }

    let scoreNum = null;
    if (!rawScore) errors.push('分数不能为空');
    else if (!/^-?\d+(\.\d+)?$/.test(rawScore)) errors.push('分数必须是数字');
    else {
      scoreNum = Number(rawScore);
      if (!Number.isFinite(scoreNum) || scoreNum < 0 || scoreNum > 100) {
        errors.push('分数超出有效范围（0-100）');
      }
    }

    let matchedBatch = null;
    if (!rawBatch) errors.push('考试批次不能为空');
    else {
      matchedBatch = batchByName.get(rawBatch);
      if (!matchedBatch) errors.push(`考试批次「${rawBatch}」不存在或未开放`);
      else if (matchedBatch.code !== batchCode) {
        errors.push(`考试批次与所选「${selected ? selected.name : batchCode}」不一致`);
      }
    }

    if (rawStudent && courseName && matchedBatch) {
      const dupKey = rawStudent + '|' + courseName + '|' + matchedBatch.code;
      if (seen.has(dupKey)) errors.push('表内重复：同一学号、课程、批次出现多条成绩');
      else seen.add(dupKey);
    }

    const ok = errors.length === 0;
    if (ok) valid++; else invalid++;

    pending.push({
      task_id: taskId,
      line_no: r + 1, // Excel 实际行号（含表头）
      student_no: rawStudent,
      course_name: ok ? courseName : rawCourse,
      score: rawScore,
      batch_name: rawBatch,
      status: ok ? 'valid' : 'invalid',
      errors: JSON.stringify(errors),
    });

    if (pending.length >= BATCH) {
      flush(pending);
      pending = [];
      // 大文件校验过程中实时更新进度，刷新页面也能看到
      db.prepare(`UPDATE tasks SET total_rows = ?, valid_rows = ?, invalid_rows = ?, updated_at = ? WHERE id = ?`)
        .run(total, valid, invalid, Date.now(), taskId);
    }
  }
  if (pending.length) flush(pending);

  db.prepare(`UPDATE tasks SET total_rows = ?, valid_rows = ?, invalid_rows = ?, status = 'validated',
    error_message = NULL, updated_at = ? WHERE id = ?`)
    .run(total, valid, invalid, Date.now(), taskId);

  return { total, valid, invalid };
}

module.exports = { parseAndValidate, buildLookups };
