'use strict';
/**
 * 分批上送市级平台
 * - 校验通过的 valid 行按 BATCH_SIZE 分批，批次号续接（支持断点续传）
 * - 批次串行发送（模拟限流），失败指数退避重试 3 次
 * - 每批结果落盘：行状态 submitted / rejected，任务统计实时更新
 * - 服务重启后，对 submitting 状态任务自动续传
 */
const store = require('./store');
const platform = require('./platformMock');
const { now, sleep } = require('./util');

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 500);
const MAX_ATTEMPTS = 3;
const running = new Set(); // 正在上送的任务 id

function recalcTaskStats(task) {
  const rows = store.getRows(task.id);
  let submitted = 0;
  let rejected = 0;
  for (const r of rows) {
    if (r.status === 'submitted') submitted++;
    else if (r.status === 'rejected') rejected++;
  }
  task.submittedRows = submitted;
  task.rejectedRows = rejected;
  const batches = store.getBatches(task.id);
  task.totalBatches = batches.length;
  task.doneBatches = batches.filter((b) => b.status === 'done').length;
}

/** 把 valid 行切分为待发送批次（幂等：已建批次不重复建） */
function planBatches(task) {
  const rows = store.getRows(task.id);
  const batches = store.getBatches(task.id);
  let nextNo = batches.length ? Math.max(...batches.map((b) => b.batchNo)) + 1 : 1;
  let pending = rows.filter((r) => r.status === 'valid' && r.bn == null);
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const slice = pending.slice(i, i + BATCH_SIZE);
    const batch = {
      taskId: task.id,
      batchNo: nextNo++,
      rowCount: slice.length,
      status: 'pending',
      attempts: 0,
      accepted: 0,
      rejected: 0,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    };
    batches.push(batch);
    for (const r of slice) r.bn = batch.batchNo;
  }
  store.markRowsDirty(task.id);
  store.markBatchesDirty(task.id);
}

async function sendBatch(task, batch) {
  const rows = store.getRows(task.id).filter((r) => r.bn === batch.batchNo && r.status === 'valid');
  batch.status = 'sending';
  batch.updatedAt = now();
  store.markBatchesDirty(task.id);

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    batch.attempts = attempt;
    batch.updatedAt = now();
    store.markBatchesDirty(task.id);
    try {
      const resp = await platform.ingestBatch({
        taskId: task.id,
        batchNo: batch.batchNo,
        attempt,
        rows: rows.map((r) => ({ n: r.n, studentNo: r.studentNo, courseCode: r.courseCode, score: r.score, examBatch: r.examBatch })),
      });
      const rejectedMap = new Map(resp.rejected.map((x) => [x.n, x.reason]));
      let accepted = 0;
      let rejected = 0;
      for (const r of rows) {
        if (rejectedMap.has(r.n)) {
          r.status = 'rejected';
          r.err = rejectedMap.get(r.n);
          rejected++;
        } else {
          r.status = 'submitted';
          r.err = null;
          accepted++;
        }
      }
      Object.assign(batch, { status: 'done', accepted, rejected, error: null, updatedAt: now() });
      store.markRowsDirty(task.id);
      store.markBatchesDirty(task.id);
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[submitter] task ${task.id} batch ${batch.batchNo} attempt ${attempt} failed: ${e.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(300 * attempt);
    }
  }
  Object.assign(batch, { status: 'failed', error: lastErr ? lastErr.message : '未知错误', updatedAt: now() });
  store.markBatchesDirty(task.id);
  throw lastErr || new Error('批次发送失败');
}

/**
 * 开始/继续上送一个任务（并发安全：同任务只跑一个循环）
 */
async function submitTask(taskId) {
  if (running.has(taskId)) return { already: true };
  const task = store.getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (!['ready', 'submitting'].includes(task.status)) {
    throw new Error(`当前状态（${task.status}）不能上送`);
  }
  running.add(taskId);
  try {
    planBatches(task);
    task.status = 'submitting';
    task.updatedAt = now();
    store.saveTask(task);

    const batches = store.getBatches(taskId);
    for (const batch of batches) {
      if (batch.status === 'done') continue;
      if (batch.status === 'sending') batch.status = 'pending'; // 崩溃恢复：重置发送中的批次
      if (batch.status !== 'pending') continue;
      try {
        await sendBatch(task, batch);
      } catch (e) {
        recalcTaskStats(task);
        Object.assign(task, { status: 'failed', error: `批次 ${batch.batchNo} 上送失败：${e.message}，可点击"重试"继续`, updatedAt: now() });
        store.saveTask(task);
        store.flush();
        return { failed: true };
      }
      recalcTaskStats(task);
      task.updatedAt = now();
      store.saveTask(task);
    }

    recalcTaskStats(task);
    Object.assign(task, { status: 'completed', error: null, updatedAt: now() });
    store.saveTask(task);
    store.flush();
    console.log(`[submitter] task ${taskId} done: submitted=${task.submittedRows}, rejected=${task.rejectedRows}`);
    return { done: true };
  } finally {
    running.delete(taskId);
  }
}

/** 失败任务重试：重置失败批次后继续 */
async function retryTask(taskId) {
  const task = store.getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'failed') throw new Error('仅失败任务可重试');
  const batches = store.getBatches(taskId);
  for (const b of batches) {
    if (b.status === 'failed' || b.status === 'sending') {
      b.status = 'pending';
      b.error = null;
      b.updatedAt = now();
    }
  }
  store.markBatchesDirty(taskId);
  task.status = 'ready';
  task.error = null;
  task.updatedAt = now();
  store.saveTask(task);
  return submitTask(taskId);
}

/** 服务启动时恢复中断的任务 */
function resumeInterruptedTasks() {
  for (const task of store.listTasks()) {
    if (task.status === 'submitting') {
      console.log(`[submitter] resume interrupted task ${task.id}`);
      submitTask(task.id).catch((e) => console.error(`[submitter] resume ${task.id} failed:`, e.message));
    } else if (task.status === 'processing') {
      // 解析过程不可断点续传，标记失败让使用者重新上传
      Object.assign(task, { status: 'failed', error: '服务重启导致解析中断，请重新上传文件', updatedAt: now() });
      store.saveTask(task);
    }
  }
}

module.exports = { submitTask, retryTask, resumeInterruptedTasks, BATCH_SIZE };
