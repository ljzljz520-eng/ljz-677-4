'use strict';
/**
 * 生成几万行的成绩大表样本（CSV）
 * 用法：node scripts/gen-sample.js [行数=30000] [输出路径]
 *
 * 正常行的 (学号,课程,批次) 保证唯一；按行号取模注入可预期比例的错误，
 * 另含市级学籍未同步学生（上送时被平台拒收，用于演示异常下载-修复-重传闭环）。
 */
const fs = require('fs');
const path = require('path');
const ref = require('../src/referenceData');
const { toCsv } = require('../src/util');

function shuffle(arr, seed) {
  for (let i = arr.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return seed;
}

function main() {
  const n = Number(process.argv[2] || 30000);
  const out = process.argv[3] || path.join(__dirname, '..', 'samples', `score-sample-${n / 10000}w.csv`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const studentNos = [...ref.students.keys()];
  const courseCodes = [...ref.courses.keys()];
  const openBatches = [...ref.examBatches.entries()].filter(([, b]) => b.status === 'open').map(([c]) => c);

  // 同一学生每多一行，换课程+批次组合，保证键唯一
  const coursePick = [0, 2, 4, 1, 3, 5, 6, 7, 8, 9, 10, 11];
  const headers = ['学号', '姓名', '课程代码', '分数', '考试批次'];
  const rows = [];
  const stats = { score: 0, studentNo: 0, course: 0, batch: 0, duplicate: 0, cityMissing: 0 };

  for (let i = 0; i < n; i++) {
    const snoIdx = i % studentNos.length;
    const variant = Math.floor(i / studentNos.length); // 同一学生的第 k 行
    const sno = studentNos[snoIdx];
    const name = ref.students.get(sno);
    const course = courseCodes[coursePick[variant % courseCodes.length]];
    const batch = openBatches[variant % openBatches.length];
    const full = ref.courses.get(course).fullScore;
    // 确定性"伪随机"分数
    const h = (i * 2654435761) % 1000 / 1000;
    let score = String(Math.round((full * (0.35 + h * 0.63)) * 10) / 10);

    const mod = i % 100;
    if (mod === 0) {
      score = ['130', '-5', 'abc', '95.123', ''][i % 5]; // 分数问题（满分120/100/60 均可能超标）
      stats.score++;
    } else if (mod === 10) {
      rows.push(['12345', name, course, '90', batch]);     // 学号格式错误
      stats.studentNo++;
      continue;
    } else if (mod === 20) {
      rows.push(['2026999999', name, course, '90', batch]); // 名册不存在
      stats.studentNo++;
      continue;
    } else if (mod === 30) {
      rows.push([sno, name, 'XX', '90', batch]);           // 课程不存在
      stats.course++;
      continue;
    } else if (mod === 40) {
      rows.push([sno, name, course, '90', '2025-NO-SUCH']);// 批次不存在
      stats.batch++;
      continue;
    } else if (mod === 50) {
      rows.push([sno, name, course, '90', '2026-CJ-QM']);  // 批次已关闭
      stats.batch++;
      continue;
    } else if (mod === 60 && rows.length > 0) {
      rows.push([...rows[rows.length - 1]]);               // 与上一行完全重复
      stats.duplicate++;
      continue;
    }
    if (!ref.cityRegistry.has(sno)) stats.cityMissing++;
    rows.push([sno, name, course, score, batch]);
  }

  shuffle(rows, 20260926);
  fs.writeFileSync(out, toCsv(headers, rows));
  console.log(`已生成 ${rows.length} 行 -> ${out}`);
  console.log('注入统计：', stats);
}
main();
