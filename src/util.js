'use strict';
const crypto = require('crypto');

/** 短任务 id：时间戳 + 随机，按时间可排序 */
function genId(prefix = 'T') {
  const ts = Date.now().toString(36).toUpperCase().padStart(9, '0');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}${ts}${rand}`;
}

/** 稳定 hash（确定性伪随机用） */
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** CSV 单元格转义 */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n'); // BOM 便于 Excel 打开
}

/** 让出事件循环，避免大文件解析阻塞 */
function yieldLoop() {
  return new Promise((r) => setImmediate(r));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { genId, hashCode, now, sleep, csvCell, toCsv, yieldLoop, HttpError };
