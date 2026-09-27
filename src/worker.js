const db = require('./db');
const platform = require('./platform');

const BATCH_SIZE = 200;
const MAX_RETRY = 3;

// 内存中的运行态标记，防止同一任务并发上送
const running = new Set();

function setStatus(id, status, extra = {}) {
  const fields = Object.keys(extra);
  const sql = `UPDATE tasks SET status = ?${fields.map(f => `, ${f} = ?`).join('')}, updated_at = ? WHERE id = ?`;
  db.prepare(sql).run(status, ...fields.map(f => extra[f]), Date.now(), id);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 继续/开始一个任务的上送：
 * 只挑选 valid / platform_failed 的行分批提交，
 * failed 行会带原因退回，可在下次"继续上送"时重发。
 */
async function runTask(taskId) {
  if (running.has(taskId)) return;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return;
  running.add(taskId);
  if (task.status !== 'uploading') setStatus(taskId, 'uploading');

  const pickRowsBase = `
    SELECT id, student_no, course_name, score FROM rows
    WHERE task_id = ? AND status IN ('valid', 'platform_failed')
  `;
  // 本次运行中已被平台拒收的行不再重试，避免死循环；等老师处理后"继续上送"
  const excluded = new Set();
  const pick = () => {
    if (excluded.size === 0) {
      return db.prepare(pickRowsBase + ' ORDER BY line_no').all(taskId);
    }
    const ids = [...excluded];
    const ph = ids.map(() => '?').join(',');
    return db.prepare(pickRowsBase + ` AND id NOT IN (${ph}) ORDER BY line_no`).all(taskId, ...ids);
  };

  const markSent = db.prepare(`UPDATE rows SET status = 'sent', platform_reason = NULL WHERE id = ?`);
  const markFailed = db.prepare(`UPDATE rows SET status = 'platform_failed', platform_reason = ? WHERE id = ?`);
  const sentTx = db.transaction((ids) => { for (const id of ids) markSent.run(id); });
  const failTx = db.transaction((items) => { for (const it of items) markFailed.run(it.reason, it.id); });

  try {
    while (true) {
      const rows = pick();
      if (rows.length === 0) break;

      const slice = rows.slice(0, BATCH_SIZE);
      const records = slice.map(r => ({
        rowId: r.id,
        studentNo: r.student_no,
        courseName: r.course_name,
        score: Number(r.score),
      }));

      let result;
      let lastErr;
      for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
          result = await platform.submitBatch(task.batch_code, records);
          break;
        } catch (e) {
          lastErr = e;
          await sleep(200 * attempt); // 退避重试
        }
      }
      if (!result) {
        setStatus(taskId, 'upload_paused', { error_message: lastErr ? lastErr.message : '平台调用失败' });
        running.delete(taskId);
        return; // 网络类故障：保留进度，用户可点"继续上送"
      }

      const rejectedById = new Map(result.rejected.filter(r => r.rowId != null)
        .map(r => [r.rowId, r.reason]));
      const sentIds = [];
      const failedItems = [];
      for (const r of records) {
        if (rejectedById.has(r.rowId)) {
          failedItems.push({ id: r.rowId, reason: rejectedById.get(r.rowId) });
          excluded.add(r.rowId);
        } else {
          sentIds.push(r.rowId);
        }
      }
      if (sentIds.length) sentTx(sentIds);
      if (failedItems.length) failTx(failedItems);

      const agg = db.prepare(`SELECT
          SUM(status = 'sent') sent,
          SUM(status = 'platform_failed') pf
        FROM rows WHERE task_id = ?`).get(taskId);
      setStatus(taskId, 'uploading', {
        uploaded_rows: agg.sent || 0,
        platform_failed_rows: agg.pf || 0,
      });
      // 让出事件循环，避免几万行时阻塞页面查询
      await sleep(10);
    }

    const agg = db.prepare(`SELECT
        SUM(status = 'sent') sent,
        SUM(status = 'platform_failed') pf
      FROM rows WHERE task_id = ?`).get(taskId);
    const sent = agg.sent || 0;
    const pf = agg.pf || 0;
    const finalStatus = pf > 0 ? 'partial' : 'done';
    setStatus(taskId, finalStatus, {
      uploaded_rows: sent,
      platform_failed_rows: pf,
      error_message: null,
    });
  } catch (e) {
    setStatus(taskId, 'upload_paused', { error_message: String(e && e.message || e) });
  } finally {
    running.delete(taskId);
  }
}

/**
 * 服务重启后的任务恢复：
 * 正在解析的任务 -> parse_failed（请重新上传原文件；这里无解析事务日志）
 * 正在上送 / 上送中断的任务 -> 依据已落库的行状态回算，可继续
 */
function recoverOnStartup() {
  const parsing = db.prepare(`SELECT id FROM tasks WHERE status = 'parsing'`).all();
  for (const t of parsing) {
    db.prepare(`UPDATE tasks SET status = 'parse_failed', error_message = ?, updated_at = ? WHERE id = ?`)
      .run('服务在文件解析过程中重启，请重新上传该文件', Date.now(), t.id);
  }
  const uploading = db.prepare(`SELECT id FROM tasks WHERE status IN ('uploading','upload_paused')`).all();
  for (const t of uploading) {
    const agg = db.prepare(`SELECT
        SUM(status = 'sent') sent,
        SUM(status IN ('valid','platform_failed')) pending,
        SUM(status = 'platform_failed') pf
      FROM rows WHERE task_id = ?`).get(t.id);
    db.prepare(`UPDATE tasks SET uploaded_rows = ?, platform_failed_rows = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(agg.sent || 0, agg.pf || 0, agg.pending > 0 ? 'upload_paused' : (agg.pf > 0 ? 'partial' : 'done'),
        Date.now(), t.id);
  }
}

module.exports = { runTask, recoverOnStartup };
