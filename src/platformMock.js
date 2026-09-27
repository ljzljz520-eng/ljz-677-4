'use strict';
/**
 * 模拟市级成绩接收平台
 * - 确定性拒绝规则：学号不在市级学籍库 -> 拒绝（模拟学籍未同步）
 * - 幂等接收：同一 学号+课程+批次 重复上送视为成功（already=true），保证重试安全
 * - 偶发 503：基于 (taskId,batchNo,attempt) 的确定性伪随机，默认 3%，第 3 次重试必定放行
 * - 学籍同步接口：演示"异常行修复后重传"闭环
 */
const express = require('express');
const { cityRegistry, getCourse } = require('./referenceData');
const { hashCode, sleep } = require('./util');

const received = new Set(); // `${studentNo}|${courseCode}|${examBatch}`
let receivedCount = 0;
let requestCount = 0;

const DELAY_MS = Number(process.env.PLATFORM_DELAY_MS || 120);
const FAIL_RATE = Number(process.env.PLATFORM_FAIL_RATE || 0.03);

/** 核心处理（express 路由与内部调用共用） */
async function ingestBatch({ taskId, batchNo, attempt = 1, rows }) {
  requestCount++;
  await sleep(DELAY_MS + Math.floor(Math.random() * DELAY_MS));

  // 偶发服务不可用（确定性伪随机，重试第 3 次起不再失败）
  const seed = hashCode(`${taskId}|${batchNo}|${attempt}`);
  if (attempt < 3 && seed % 100 < FAIL_RATE * 100) {
    const err = new Error('市级平台暂时不可用（503）');
    err.status = 503;
    err.retryable = true;
    throw err;
  }

  const accepted = [];
  const rejected = [];
  for (const r of rows) {
    const key = `${r.studentNo}|${r.courseCode}|${r.examBatch}`;
    if (received.has(key)) {
      accepted.push({ n: r.n, already: true });
      continue;
    }
    if (!cityRegistry.has(r.studentNo)) {
      rejected.push({ n: r.n, reason: `市级平台无此学生学籍（学号 ${r.studentNo} 未同步）` });
      continue;
    }
    const course = getCourse(r.courseCode);
    const score = Number(r.score);
    if (!course || !Number.isFinite(score) || score < 0 || score > course.fullScore) {
      rejected.push({ n: r.n, reason: '市级平台校验未通过：分数或课程不合法' });
      continue;
    }
    received.add(key);
    receivedCount++;
    accepted.push({ n: r.n, already: false });
  }
  return { batchNo, accepted, rejected };
}

/** 挂到主服务上，模拟"外部"市级平台 */
function mountMockPlatform(app) {
  const router = express.Router();
  router.use(express.json({ limit: '20mb' }));

  router.post('/ingest', async (req, res) => {
    try {
      const { taskId, batchNo, attempt, rows } = req.body || {};
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows 必须是数组' });
      const result = await ingestBatch({ taskId, batchNo, attempt, rows });
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, retryable: !!e.retryable });
    }
  });

  router.get('/stats', (req, res) => {
    res.json({ requestCount, receivedCount, registrySize: cityRegistry.size });
  });

  // 演示用：把学号同步进市级学籍库（真实场景由学籍系统对接）
  router.post('/admin/sync-students', (req, res) => {
    const nos = (req.body && req.body.studentNos) || [];
    let added = 0;
    for (const no of nos) {
      if (!cityRegistry.has(no)) {
        cityRegistry.add(no);
        added++;
      }
    }
    res.json({ synced: added, registrySize: cityRegistry.size });
  });

  app.use('/mock-platform', router);
}

module.exports = { mountMockPlatform, ingestBatch };
