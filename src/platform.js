/**
 * 市级成绩平台客户端（模拟）。
 * 真实场景下替换为 HTTP 调用即可，接口契约保持不变：
 *   POST /api/platform/scores  body: { batchCode, records: [{studentNo, courseName, score}] }
 *   成功返回 { accepted: [...], rejected: [{studentNo,courseName,score,reason}], traceId }
 *   限流/故障时返回 503。
 */

const crypto = require('crypto');

function hashReject(studentNo, courseName, batchCode) {
  const h = crypto.createHash('md5').update(studentNo + courseName + batchCode).digest();
  // 确定性拒收，约 4.3%（同一数据每次结果一致，便于演示"修正后重传成功"）
  return h[0] % 23 === 0;
}

const REASONS = [
  '市级平台校验失败：该生学籍状态为转出，成绩不予接收',
  '市级平台校验失败：该科目在本考试批次未安排',
  '市级平台幂等冲突：批次内已有该生该科目成绩，需走更正流程',
  '市级平台校验失败：成绩录入时间晚于批次截止时间',
];

let requests = 0;

function submitBatch(batchCode, records) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      requests++;
      // 每 17 个请求模拟一次平台限流，触发客户端重试
      if (requests % 17 === 0) {
        const err = new Error('市级平台繁忙（HTTP 503），请稍后重试');
        err.status = 503;
        return reject(err);
      }
      const accepted = [];
      const rejected = [];
      for (const rec of records) {
        if (hashReject(rec.studentNo, rec.courseName, batchCode)) {
          const idx = rec.studentNo.charCodeAt(rec.studentNo.length - 1) % REASONS.length;
          rejected.push({ ...rec, reason: REASONS[idx] });
        } else {
          accepted.push({ ...rec, platformId: 'M' + crypto.randomBytes(6).toString('hex') });
        }
      }
      resolve({
        traceId: crypto.randomBytes(8).toString('hex'),
        accepted,
        rejected,
      });
    }, 30 + Math.floor(Math.random() * 70));
  });
}

module.exports = { submitBatch };
