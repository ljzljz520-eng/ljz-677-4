'use strict';
/**
 * 行级校验：学号 / 课程 / 分数 / 考试批次 / 文件内重复
 */
const { getStudent, getCourse, getExamBatch } = require('./referenceData');

const STUDENT_NO_RE = /^\d{10}$/;

/**
 * @returns {string|null} 错误信息；null 表示通过
 */
function validateRow(row, seenKeys) {
  const studentNo = (row.studentNo || '').trim();
  const courseCode = (row.courseCode || '').trim();
  const scoreRaw = String(row.score ?? '').trim();
  const examBatch = (row.examBatch || '').trim();

  // 学号
  if (!studentNo) return '学号为空';
  if (!STUDENT_NO_RE.test(studentNo)) return `学号格式错误（应为10位数字）：${studentNo}`;
  if (!getStudent(studentNo)) return `学号不在学生名册中：${studentNo}`;

  // 课程
  if (!courseCode) return '课程代码为空';
  const course = getCourse(courseCode);
  if (!course) return `课程代码不存在：${courseCode}`;

  // 分数
  if (!scoreRaw) return '分数为空';
  const score = Number(scoreRaw);
  if (!Number.isFinite(score)) return `分数不是数字：${scoreRaw}`;
  if (score < 0) return `分数不能为负：${scoreRaw}`;
  if (score > course.fullScore) return `分数超过课程满分${course.fullScore}：${scoreRaw}`;
  if (!Number.isInteger(score * 10)) return `分数最多保留1位小数：${scoreRaw}`;

  // 考试批次
  if (!examBatch) return '考试批次为空';
  const batch = getExamBatch(examBatch);
  if (!batch) return `考试批次不存在：${examBatch}`;
  if (batch.status !== 'open') return `考试批次已关闭，不能报送：${examBatch}（${batch.name}）`;

  // 文件内重复
  const key = `${studentNo}|${courseCode}|${examBatch}`;
  if (seenKeys.has(key)) return `文件内重复成绩（学号+课程+批次）：${studentNo}/${courseCode}/${examBatch}`;
  seenKeys.add(key);

  return null;
}

module.exports = { validateRow, STUDENT_NO_RE };
