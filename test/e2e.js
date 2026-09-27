'use strict';
/**
 * 端到端测试：
 *  1. 3 万行样本上传 -> 行级校验（学号/课程/分数/批次/重复）
 *  2. 分批上送模拟市级平台 -> 批次重试 / 平台拒收统计
 *  3. 下载异常 CSV -> 修复（同步市级学籍 + 修正分数）-> 重传 -> 全部上送成功（闭环）
 *  4. 进程崩溃恢复：上送中杀进程，重启后自动续传直到完成
 *  5. 历史任务持久化：重启后任务列表仍可查看（刷新不丢）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parse: parseCsvSync } = require('csv-parse/sync');

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grade-e2e-'));
const SERVER = path.join(__dirname, '..', 'server.js');
const SAMPLE = path.join(__dirname, '..', 'samples', 'score-sample-3w.csv');

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.error('  ❌ ' + msg); }
}

function httpJson(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const isBuffer = Buffer.isBuffer(body);
    const data = body ? (isBuffer ? body : JSON.stringify(body)) : null;
    const finalHeaders = { ...headers };
    if (data && !isBuffer && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    const req = http.request(BASE + urlPath, { method, headers: finalHeaders, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, raw, json: safeJson(raw), headers: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.end(data);
    else req.end();
  });
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

function uploadFile(file, parentTaskId) {
  const boundary = '----e2e' + Date.now();
  const parts = [];
  if (parentTaskId) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parentTaskId"\r\n\r\n${parentTaskId}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(file)}"\r\nContent-Type: text/csv\r\n\r\n`));
  parts.push(fs.readFileSync(file));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const buf = Buffer.concat(parts);
  return httpJson('POST', '/api/tasks', buf, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': buf.length,
  });
}

async function waitTask(id, until, timeoutMs = 60000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await httpJson('GET', '/api/tasks/' + id);
    if (!json) throw new Error('任务查询失败 ' + id);
    if (until(json)) { console.log(`     …${label} 完成（${Date.now() - t0}ms）状态=${json.status}`); return json; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等待任务 ${id} 超时（${label}）`);
}

let serverProc = null;
function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: TMP,
      BATCH_SIZE: '200',
      PLATFORM_DELAY_MS: '20',
      PLATFORM_FAIL_RATE: '0.15', // 高失败率以验证批次重试
    };
    serverProc = spawn(process.execPath, [SERVER], { env });
    let ready = false;
    serverProc.stdout.on('data', (d) => {
      const s = d.toString();
      if (!ready && s.includes('已启动')) { ready = true; resolve(); }
    });
    serverProc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
    serverProc.on('exit', (code) => { if (!ready) reject(new Error('server exited ' + code)); });
    setTimeout(() => !ready && reject(new Error('server start timeout')), 10000);
  });
}
function stopServer(signal = 'SIGTERM') {
  return new Promise((resolve) => {
    if (!serverProc || serverProc.killed) return resolve();
    serverProc.on('exit', () => resolve());
    serverProc.kill(signal);
    setTimeout(resolve, 3000);
  });
}
function hardKill() {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL');
}

async function run() {
  if (!fs.existsSync(SAMPLE)) {
    console.error('请先运行 node scripts/gen-sample.js 30000');
    process.exit(1);
  }
  console.log(`测试数据目录: ${TMP}`);

  // ---------- 场景 1：上传 + 校验 ----------
  console.log('\n[1] 上传 3 万行样本，等待解析校验完成');
  await startServer();
  const up = await uploadFile(SAMPLE);
  assert(up.status === 202, '上传接口返回 202（异步处理）');
  const t1 = up.json;
  assert(t1 && t1.status === 'processing', '任务初始状态为 processing');

  const ready = await waitTask(t1.id, (t) => t.status === 'ready' || t.status === 'failed', 60000, '解析校验');
  assert(ready.status === 'ready', '校验完成进入 ready（待上送）');
  assert(ready.totalRows === 30000, `总行数 30000（实际 ${ready.totalRows}）`);
  assert(ready.invalidRows >= 2000 && ready.invalidRows <= 2200, `校验异常约 2100（实际 ${ready.invalidRows}）`);
  assert(ready.validRows === ready.totalRows - ready.invalidRows, 'valid + invalid = total');

  // 异常行分页接口
  const invPage = await httpJson('GET', `/api/tasks/${t1.id}/rows?status=invalid&page=1&size=20`);
  assert(invPage.json.total === ready.invalidRows, '异常行分页 total 与统计一致');
  assert(invPage.json.items[0].err && invPage.json.items[0].status === 'invalid', '异常行带错误原因');

  // ---------- 场景 2：分批上送 ----------
  console.log('\n[2] 分批上送市级平台（批次200行，平台15%概率503验证重试）');
  const expectedBatches = Math.ceil(ready.validRows / 200);
  await httpJson('POST', `/api/tasks/${t1.id}/submit`);
  const done = await waitTask(t1.id, (t) => ['completed', 'failed'].includes(t.status), 120000, '上送');
  assert(done.status === 'completed', `任务完成（实际 ${done.status} ${done.error || ''}）`);
  assert(done.totalBatches === expectedBatches, `批次总数 ceil(valid/200)=${expectedBatches}（实际 ${done.totalBatches}）`);
  assert(done.doneBatches === done.totalBatches, '所有批次成功（含重试）');
  assert(done.submittedRows + done.rejectedRows === done.validRows, '已接收 + 拒收 = 校验通过数（守恒）');
  assert(done.rejectedRows > 0, `存在平台拒收行（实际 ${done.rejectedRows}，主要为市级学籍未同步）`);
  const batches = (await httpJson('GET', `/api/tasks/${t1.id}/batches`)).json;
  const retried = batches.filter((b) => b.attempts > 1);
  assert(retried.length > 0, `确有批次经历过重试（${retried.length} 个批次 attempts>1）`);
  assert(batches.every((b) => b.status === 'done'), '批次记录全部 done');
  const stats1 = (await httpJson('GET', '/mock-platform/stats')).json;
  assert(stats1 && stats1.receivedCount === done.submittedRows, '平台侧接收计数与任务统计一致');

  // ---------- 场景 3：异常行下载 -> 修复 -> 重传闭环 ----------
  console.log('\n[3] 下载异常行 CSV，修复后重传');
  const invalidCsv = (await httpJson('GET', `/api/tasks/${t1.id}/errors.csv?source=invalid`)).raw;
  const rejectedCsv = (await httpJson('GET', `/api/tasks/${t1.id}/errors.csv?source=rejected`)).raw;
  const bothCsv = (await httpJson('GET', `/api/tasks/${t1.id}/errors.csv?source=both`)).raw;
  assert(invalidCsv.includes('错误原因') && rejectedCsv.includes('错误原因'), '异常 CSV 含"错误原因"列，可直接改数重传');
  const bothRows = parseCsvSync(bothCsv, { bom: true, skip_empty_lines: true });
  assert(bothRows.length - 1 === done.invalidRows + done.rejectedRows,
    `全部异常 CSV 数据行数 = ${done.invalidRows + done.rejectedRows}（实际 ${bothRows.length - 1}）`);

  // 解析拒收行，取其中的学号，调用平台学籍同步（模拟学籍科补同步），然后重传拒收文件
  const rejRows = parseCsvSync(rejectedCsv, { bom: true, skip_empty_lines: true });
  const rejHeader = rejRows[0];
  const rejData = rejRows.slice(1);
  const rejStudentNos = [...new Set(rejData.map((r) => r[0]).filter((s) => /^\d{10}$/.test(s)))];
  assert(rejStudentNos.length > 0, '拒收文件中解析出待同步学号');
  const sync = await httpJson('POST', '/mock-platform/admin/sync-students', { studentNos: rejStudentNos });
  assert(sync.json.synced > 0, `市级学籍同步 ${sync.json.synced} 人`);

  const rejectedFile = path.join(TMP, 'rejected.csv');
  fs.writeFileSync(rejectedFile, rejectedCsv);
  const up2 = await uploadFile(rejectedFile, t1.id);
  const t2 = await waitTask(up2.json.id, (t) => ['ready', 'failed'].includes(t.status), 60000, '重传解析');
  assert(t2.parentTaskId === t1.id, '重传任务记录了来源任务 parentTaskId');
  assert(t2.invalidRows === 0, `重传文件校验 0 异常（实际 ${t2.invalidRows}，错误原因列被自动忽略）`);
  assert(t2.validRows === rejData.length, `重传有效行 ${rejData.length}（实际 ${t2.validRows}）`);

  await httpJson('POST', `/api/tasks/${t2.id}/submit`);
  const done2 = await waitTask(t2.id, (t) => ['completed', 'failed'].includes(t.status), 60000, '重传上送');
  assert(done2.status === 'completed', '重传任务完成');
  assert(done2.rejectedRows === 0, `学籍同步后平台拒收 0（实际 ${done2.rejectedRows}）`);
  assert(done2.submittedRows === t2.validRows, '重传行全部被平台接收');

  // 校验异常行的修复：保留"错误原因"列，只修正一个分数超标的行，确认带该列也能解析
  const fixedFile = path.join(TMP, 'fixed-invalid.csv');
  const invRows = parseCsvSync(invalidCsv, { bom: true, skip_empty_lines: true });
  const invHeader = invRows[0];
  let fixed = 0;
  for (const r of invRows.slice(1)) {
    if (!fixed && String(r[5]).includes('超过课程满分')) {
      r[3] = '90';
      fixed++;
    }
  }
  const fixedCsv = [invHeader, ...invRows.slice(1)]
    .map((cols) => cols.map((c) => (/[",\r\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(','))
    .join('\r\n');
  fs.writeFileSync(fixedFile, '﻿' + fixedCsv);
  const t3 = await waitTask((await uploadFile(fixedFile, t1.id)).json.id, (t) => ['ready', 'failed'].includes(t.status), 60000, '修复文件解析');
  // 异常文件只含被判重的"第二份"行，单独成文件后不再构成文件内重复，属于合理放行
  const dupCount = invRows.slice(1).filter((r) => String(r[5]).includes('文件内重复')).length;
  const expectedInvalid = invRows.length - 1 - dupCount - fixed; // 数据行 - 重复洗白 - 已修复
  assert(fixed === 1 && t3.invalidRows === expectedInvalid,
    `带"错误原因"列重传：修复 ${fixed} 行、重复行独立后合法，期望异常 ${expectedInvalid}（实际 ${t3.invalidRows}）`);
  assert(t3.validRows === dupCount + fixed, `修复行与原重复行均校验通过（valid=${t3.validRows}）`);

  // ---------- 场景 4：崩溃恢复 ----------
  console.log('\n[4] 上送过程中强制杀进程（SIGKILL），重启自动续传');
  const big = await uploadFile(SAMPLE);
  await waitTask(big.json.id, (t) => t.status === 'ready' || t.status === 'failed', 60000, '第二任务解析');
  await httpJson('POST', `/api/tasks/${big.json.id}/submit`);
  const mid = await waitTask(
    big.json.id,
    (t) => t.status === 'submitting' && t.totalBatches > 0 && t.doneBatches < t.totalBatches,
    15000,
    '进入上送中'
  );
  assert(mid.status === 'submitting' && mid.doneBatches < mid.totalBatches,
    `杀进程时上送进行中（批次 ${mid.doneBatches}/${mid.totalBatches}）`);
  hardKill();
  await new Promise((r) => setTimeout(r, 400));

  await startServer(); // 同 DATA_DIR 重启
  const resumed = await waitTask(big.json.id, (t) => ['completed', 'failed'].includes(t.status), 120000, '重启续传');
  assert(resumed.status === 'completed', '重启后任务自动续传完成');
  assert(resumed.submittedRows + resumed.rejectedRows === resumed.validRows, '续传后计数依然守恒');
  assert(resumed.doneBatches === resumed.totalBatches, '所有批次完成（无重复、无丢失）');

  // ---------- 场景 5：历史任务持久化 ----------
  console.log('\n[5] 历史任务持久化（模拟浏览器刷新/重开）');
  const list = (await httpJson('GET', '/api/tasks')).json;
  const ids = new Set(list.map((t) => t.id));
  assert(ids.has(t1.id) && ids.has(t2.id) && ids.has(t3.id) && ids.has(big.json.id), '重启后全部历史任务仍可查看');
  assert(list.every((t) => typeof t.totalRows === 'number'), '列表任务统计字段完整');

  await stopServer();
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

run().catch(async (e) => {
  console.error('\nE2E 异常：', e);
  hardKill();
  process.exit(1);
});
