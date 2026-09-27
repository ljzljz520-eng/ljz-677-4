const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  batch_code TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  uploaded_rows INTEGER NOT NULL DEFAULT 0,
  platform_failed_rows INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'parsing',
  error_message TEXT,
  parent_task_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  student_no TEXT,
  course_name TEXT,
  score TEXT,
  batch_name TEXT,
  status TEXT NOT NULL,
  errors TEXT NOT NULL DEFAULT '[]',
  platform_reason TEXT,
  UNIQUE(task_id, line_no),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rows_task_status ON rows(task_id, status);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS students (
  student_no TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  class_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]'
);
`);

function seed() {
  const batchCount = db.prepare('SELECT COUNT(*) c FROM batches').get().c;
  if (batchCount === 0) {
    const ins = db.prepare('INSERT INTO batches (code, name, active) VALUES (?, ?, 1)');
    [
      ['202603', '2025-2026学年第二学期3月月考'],
      ['202604', '2025-2026学年第二学期期中考试'],
      ['202606', '2025-2026学年第二学期期末考试'],
      ['202511', '2025-2026学年第一学期期中考试'],
    ].forEach(b => ins.run(...b));
  }

  const courseCount = db.prepare('SELECT COUNT(*) c FROM courses').get().c;
  if (courseCount === 0) {
    const ins = db.prepare('INSERT INTO courses (code, name, aliases) VALUES (?, ?, ?)');
    [
      ['CHN', '语文', '["语文","yuwen","Chinese"]'],
      ['MATH', '数学', '["数学","shuxue","Math","Maths"]'],
      ['ENG', '英语', '["英语","yingyu","English"]'],
      ['PHY', '物理', '["物理","wuli","Physics"]'],
      ['CHEM', '化学', '["化学","huaxue","Chemistry"]'],
      ['BIO', '生物', '["生物","shengwu","Biology"]'],
      ['POL', '道德与法治', '["道德与法治","政治","道法","思政"]'],
      ['HIS', '历史', '["历史","lishi","History"]'],
      ['GEO', '地理', '["地理","dili","Geography"]'],
    ].forEach(c => ins.run(...c));
  }

  const stuCount = db.prepare('SELECT COUNT(*) c FROM students').get().c;
  if (stuCount === 0) {
    const ins = db.prepare('INSERT INTO students (student_no, name, class_name) VALUES (?, ?, ?)');
    const tx = db.transaction((list) => { for (const s of list) ins.run(...s); });
    const list = [];
    // 学号：10位 = 入学年份(4) + 班级序号(3) + 班内序号(3)，共 6×20×50 = 6000 人
    const gradeYears = ['2020', '2021', '2022', '2023', '2024', '2025'];
    let n = 0;
    for (const gy of gradeYears) {
      for (let cls = 1; cls <= 20; cls++) {
        const clsPart = String(cls).padStart(3, '0');
        for (let i = 1; i <= 50; i++) {
          const no = gy + clsPart + String(i).padStart(3, '0');
          const clsName = `${parseInt(gy, 10)}级${cls}班`;
          list.push([no, `学生${++n}`, clsName]);
        }
      }
    }
    tx(list);
  }
}
seed();

module.exports = db;
