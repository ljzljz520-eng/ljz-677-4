'use strict';
/**
 * 模拟区县级基础数据（真实场景来自学籍系统/教务系统接口）
 * - 学生名册：学号(10位) -> 姓名
 * - 课程字典：课程代码 -> { name, fullScore }
 * - 考试批次：批次代码 -> { name, status: open|closed }
 */
const { hashCode } = require('./util');

const STUDENT_COUNT = Number(process.env.MOCK_STUDENTS || 6000);

// 学生名册：2026 + 6 位序号，共 6000 人
const students = new Map();
const FAMILY = '张王李赵刘陈杨黄周吴徐孙马朱胡郭何罗高林郑梁谢宋唐许韩冯邓曹彭'.split('');
const GIVEN = '伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀兰霞平刚桂英华玉萍红梅兰竹晨曦宇泽昊天思雨欣怡子轩浩然'.split('');
for (let i = 1; i <= STUDENT_COUNT; i++) {
  const no = '2026' + String(i).padStart(6, '0');
  const name = FAMILY[i % FAMILY.length] + GIVEN[(i * 7) % GIVEN.length] + (i % 3 === 0 ? GIVEN[(i * 13) % GIVEN.length] : '');
  students.set(no, name);
}

// 课程字典（代码 -> 名称/满分）
const courses = new Map([
  ['YW', { name: '语文', fullScore: 120 }],
  ['SX', { name: '数学', fullScore: 120 }],
  ['YY', { name: '英语', fullScore: 120 }],
  ['WL', { name: '物理', fullScore: 100 }],
  ['HX', { name: '化学', fullScore: 100 }],
  ['SW', { name: '生物', fullScore: 100 }],
  ['ZZ', { name: '政治', fullScore: 100 }],
  ['LS', { name: '历史', fullScore: 100 }],
  ['DL', { name: '地理', fullScore: 100 }],
  ['TY', { name: '体育', fullScore: 60 }],
  ['YY2', { name: '音乐', fullScore: 100 }],
  ['MS', { name: '美术', fullScore: 100 }],
]);

// 考试批次
const examBatches = new Map([
  ['2026-QJ-QZ', { name: '2026 秋季期中', status: 'open' }],
  ['2026-QJ-QM', { name: '2026 秋季期末', status: 'open' }],
  ['2026-CJ-QM', { name: '2026 春季期末', status: 'closed' }],
]);

function getStudent(no) {
  return students.get(no) || null;
}
function getCourse(code) {
  return courses.get(code) || null;
}
function getExamBatch(code) {
  return examBatches.get(code) || null;
}

/** 市级平台学籍库：名册的约 97%（确定性选取，模拟学籍未同步的情形） */
const cityRegistry = new Set();
for (const no of students.keys()) {
  if (hashCode('city|' + no) % 100 < 97) cityRegistry.add(no);
}

module.exports = {
  students,
  courses,
  examBatches,
  cityRegistry,
  getStudent,
  getCourse,
  getExamBatch,
  meta() {
    return {
      studentCount: students.size,
      courses: [...courses.entries()].map(([code, c]) => ({ code, ...c })),
      examBatches: [...examBatches.entries()].map(([code, b]) => ({ code, ...b })),
      cityRegistryCount: cityRegistry.size,
    };
  },
};
