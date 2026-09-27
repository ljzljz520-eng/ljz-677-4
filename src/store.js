'use strict';
/**
 * 轻量持久化存储层（零原生依赖）
 * - data/tasks.json            任务元数据（小文件，变更即写）
 * - data/rows/<taskId>.json    每个任务的行数据（防抖落盘）
 * - data/batches/<taskId>.json 每个任务的批次记录（防抖落盘）
 * 进程退出前 flush，重启后全量恢复。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const ROWS_DIR = path.join(DATA_DIR, 'rows');
const BATCHES_DIR = path.join(DATA_DIR, 'batches');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

for (const d of [DATA_DIR, ROWS_DIR, BATCHES_DIR, path.join(DATA_DIR, 'uploads')]) {
  fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    /** @type {Map<string, object>} 任务元数据 */
    this.tasks = new Map();
    /** @type {Map<string, Array>} taskId -> 行数组（懒加载） */
    this.rows = new Map();
    /** @type {Map<string, Array>} taskId -> 批次数组（懒加载） */
    this.batches = new Map();
    this._dirty = new Set(); // 'tasks' | 'rows:<id>' | 'batches:<id>'
    this._timer = null;
    this._flushIntervalMs = Number(process.env.STORE_FLUSH_MS || 300);
    this._load();
  }

  _load() {
    const list = readJson(TASKS_FILE, []);
    for (const t of list) this.tasks.set(t.id, t);
  }

  // ---------- 任务 ----------
  saveTask(task) {
    this.tasks.set(task.id, task);
    this._mark('tasks');
  }

  getTask(id) {
    return this.tasks.get(id) || null;
  }

  listTasks() {
    return [...this.tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  // ---------- 行 ----------
  getRows(taskId) {
    if (!this.rows.has(taskId)) {
      this.rows.set(taskId, readJson(path.join(ROWS_DIR, taskId + '.json'), []));
    }
    return this.rows.get(taskId);
  }

  setRows(taskId, rows) {
    this.rows.set(taskId, rows);
    this._mark('rows:' + taskId);
  }

  markRowsDirty(taskId) {
    this._mark('rows:' + taskId);
  }

  // ---------- 批次 ----------
  getBatches(taskId) {
    if (!this.batches.has(taskId)) {
      this.batches.set(taskId, readJson(path.join(BATCHES_DIR, taskId + '.json'), []));
    }
    return this.batches.get(taskId);
  }

  markBatchesDirty(taskId) {
    this._mark('batches:' + taskId);
  }

  // ---------- 落盘 ----------
  _mark(key) {
    this._dirty.add(key);
    if (!this._timer) {
      this._timer = setTimeout(() => this.flush(), this._flushIntervalMs);
      if (this._timer.unref) this._timer.unref();
    }
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._dirty.size === 0) return;
    const dirty = [...this._dirty];
    this._dirty.clear();
    for (const key of dirty) {
      try {
        if (key === 'tasks') {
          writeJsonAtomic(TASKS_FILE, this.listTasks());
        } else if (key.startsWith('rows:')) {
          const id = key.slice(5);
          writeJsonAtomic(path.join(ROWS_DIR, id + '.json'), this.rows.get(id) || []);
        } else if (key.startsWith('batches:')) {
          const id = key.slice(8);
          writeJsonAtomic(path.join(BATCHES_DIR, id + '.json'), this.batches.get(id) || []);
        }
      } catch (e) {
        console.error('[store] flush failed for', key, e.message);
        this._dirty.add(key); // 下次重试
      }
    }
  }
}

const store = new Store();

function shutdownFlush() {
  try {
    store.flush();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdownFlush);
process.on('SIGTERM', shutdownFlush);

module.exports = store;
