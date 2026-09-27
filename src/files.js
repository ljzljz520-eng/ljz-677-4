const XLSX = require('xlsx');
const db = require('./db');

const HEADERS = ['学号', '课程', '分数', '考试批次'];

function wbBuffer(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 8 }, { wch: 36 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '成绩');
  // 启用自动筛选，方便老师筛选异常行
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: aoa[0].length - 1, r: aoa.length - 1 } }) };
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function templateBuffer(batchName) {
  const name = batchName || db.prepare('SELECT name FROM batches WHERE active = 1 ORDER BY id LIMIT 1').get().name;
  const aoa = [
    HEADERS,
    ['（学号为10位数字，请设置为文本格式，避免前导零丢失）', '语文', 90, name],
    ['', '数学', 88.5, name],
  ];
  return wbBuffer(aoa);
}

/**
 * 生成示例大表：含少量校验异常行与平台拒收行，便于演示完整流程。
 */
function sampleBuffer(count, batchCode) {
  const batch = db.prepare('SELECT * FROM batches WHERE code = ?').get(batchCode);
  const courses = db.prepare('SELECT name FROM courses').all().map(c => c.name);
  const students = db.prepare('SELECT student_no FROM students ORDER BY student_no').all();

  const aoa = [HEADERS];
  const C = courses.length;
  for (let i = 0; i < count; i++) {
    // 依次取 学号×课程 的笛卡尔积，5 万行内不会产生正常的键重复
    const course = courses[i % C];
    const stu = students[Math.floor(i / C) % students.length];
    let studentNo = stu.student_no;
    let courseName = course;
    let score = String(40 + Math.floor(Math.random() * 60) + (Math.random() < 0.2 ? 0.5 : 0));
    let batchName = batch.name;

    const m = i % 47;
    if (m === 0) studentNo = studentNo.slice(0, -1) + 'X';      // 学号含非法字符
    else if (m === 7) studentNo = '2024' + String(900000 + i).slice(-6); // 10位但学号不存在（每行不同）
    else if (m === 11) courseName = '美术';                      // 课程不存在
    else if (m === 15) score = '缺考';                            // 分数非数字
    else if (m === 19) score = '105';                            // 分数超范围
    else if (m === 23) batchName = '2008年春季期末考试';          // 批次不存在
    else if (m === 27) score = '';                               // 分数为空
    // i=31,32 制造一对表内重复：第 32 行完全复制第 31 行的学号/课程/批次
    if (m === 32) {
      const dupStu = students[Math.floor(31 / C) % students.length].student_no;
      const dupCourse = courses[31 % C];
      aoa.push([dupStu, dupCourse, score, batchName]);
    } else {
      aoa.push([studentNo, courseName, score, batchName]);
    }
  }
  return wbBuffer(aoa);
}

/**
 * 导出异常行：本地校验失败 + 市级平台拒收。
 * - 校验失败：错误写在最后一列，原数据不变，老师改完删掉错误列即可重传；
 *   为兼容"直接改完就传"，错误列名不参与导入识别（导出文件里保留说明列，上传时被忽略）。
 */
function errorRowsBuffer(taskId) {
  const rows = db.prepare(`
    SELECT * FROM rows WHERE task_id = ?
      AND (status = 'invalid' OR status = 'platform_failed')
    ORDER BY line_no
  `).all(taskId);
  const aoa = [[...HEADERS, '异常原因', '原始行号']];
  for (const r of rows) {
    let reason;
    if (r.status === 'invalid') reason = JSON.parse(r.errors).join('；');
    else reason = r.platform_reason || '市级平台拒收';
    aoa.push([r.student_no || '', r.course_name || '', r.score || '', r.batch_name || '', reason, r.line_no]);
  }
  if (aoa.length > 1) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 8 }, { wch: 36 }, { wch: 50 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '异常行');
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: 5, r: aoa.length - 1 } }) };
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }
  return wbBuffer(aoa);
}

module.exports = { templateBuffer, sampleBuffer, errorRowsBuffer };
