# 教育成绩大表导入系统

老师上传几万条成绩 → 系统逐行校验（学号 / 课程 / 分数 / 考试批次）→ 校验通过行**分批上送市级平台**（失败重试、断点续传）→ 返回的异常行可**下载 CSV、修改后直接重传**。任务状态全部持久化在服务端，**浏览器刷新、关闭重开、甚至服务重启，历史任务都可恢复查看**。

## 快速开始

```bash
npm install
npm start                 # http://localhost:8080

npm run gen-sample        # 生成 3 万行演示样本 samples/score-sample-3w.csv（含各类错误）
npm test                  # 端到端测试（34 项断言，含 SIGKILL 崩溃恢复）
```

页面操作：
1. 首页上传成绩表（`.csv` / `.xlsx`，GBK/UTF-8 均可；表头：`学号,姓名,课程代码,分数,考试批次`），或先下载导入模板；
2. 进入任务详情，实时查看解析/校验进度、异常行及错误原因；
3. 点击「分批上送市级平台」，按 500 行/批串行上送，可查看每批状态与尝试次数；
4. 平台拒收 / 校验异常行可点「下载全部异常行」（CSV 自带"错误原因"列，该列在重传时自动忽略），本地修改后点「修复后重传」形成闭环；
5. 任何时候刷新浏览器，列表和任务进度都从服务端恢复。

## 校验规则

| 字段 | 规则 |
| --- | --- |
| 学号 | 必填；10 位数字；必须存在于学生名册（`src/referenceData.js` 中模拟 6000 人） |
| 课程 | 课程代码必须在字典中（YW 语文 / SX 数学 / YY 英语 …），各门课有独立满分 |
| 分数 | 必填、数字、`0 ~ 课程满分`、最多 1 位小数 |
| 考试批次 | 批次必须存在且状态为"开放报送"（关闭批次拒绝报送） |
| 组合 | 同一文件内 `学号 + 课程 + 批次` 不得重复 |

## 模拟市级平台

`/mock-platform/*` 模拟外部市级接收系统（真实部署替换为对方 HTTP 接口即可）：

- `POST /mock-platform/ingest`：接收一批成绩；**幂等**（同键重复上送视为成功，保证重试安全）；
  确定性拒绝市级学籍库中不存在的学号（模拟学籍未同步）；按 `(任务,批次,尝试次数)` 确定性产生约 3% 的 503；
- `POST /mock-platform/admin/sync-students`：演示学籍补同步（异常修复闭环用）；
- `GET /mock-platform/stats`：平台侧接收计数。

## 关键设计

- **异步流水线**：上传立即返回任务（202）；解析校验、分批上送均后台执行，前端 1.5s 轮询；
  CSV 流式解析、XLSX 读首个工作表，每 2000 行让出事件循环并落盘进度；
- **分批与重试**：仅 `valid` 行进批（默认 500/批，`BATCH_SIZE` 可调），批次串行（模拟限流）；
  503/网络错误指数退避重试 3 次；失败批次可一键「从中断处重试」；
- **断点续传**：批次与行状态落盘；服务重启后 `submitting` 任务自动续传（发送中的批次重置重发，
  靠平台幂等保证不重复入库）；解析中崩溃的任务标记失败、提示重新上传；
- **持久化（零原生依赖）**：不依赖数据库，JSON 分文件 + 原子写（tmp+rename）+ 300ms 防抖落盘：
  - `data/tasks.json` 任务元数据（小，即时写）
  - `data/rows/<任务id>.json` 全部行（状态机：`valid → submitted/rejected`，异常行为 `invalid`）
  - `data/batches/<任务id>.json` 批次记录
  生产环境若要更强并发/查询能力，可将 `src/store.js` 替换为 SQLite/Postgres 实现，接口不变；
- **异常闭环**：异常 CSV 带原 5 列 + "错误原因"列，下载后直接改数即可重传；重传任务记录 `parentTaskId`；
- **刷新恢复**：前端为 hash 路由的瘦客户端，不保存任何任务状态；打开页面即调 `GET /api/tasks` 全量恢复。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meta` | 名册/课程/批次等校验依据 |
| GET | `/api/template.csv` | 导入模板 |
| POST | `/api/tasks` | multipart 上传成绩表，创建任务 |
| GET | `/api/tasks` | 任务列表（恢复历史） |
| GET | `/api/tasks/:id` | 任务详情（含各项计数） |
| GET | `/api/tasks/:id/rows?status=problem\|invalid\|rejected\|all&page=&size=` | 行数据分页 |
| GET | `/api/tasks/:id/batches` | 上送批次记录 |
| POST | `/api/tasks/:id/submit` | 开始/继续分批上送 |
| POST | `/api/tasks/:id/retry` | 失败后从断点批次重试 |
| GET | `/api/tasks/:id/errors.csv?source=both\|invalid\|rejected` | 下载异常行（可直接重传） |

## 目录结构

```
server.js               Express 入口（静态页 + /api + /mock-platform）
src/
  store.js              JSON 分文件持久化（原子写/防抖/退出 flush）
  referenceData.js      学生名册、课程字典、考试批次、市级学籍库（模拟）
  validator.js          行级校验
  importer.js           CSV(GBK/UTF-8)/XLSX 解析 → 逐行校验 → 落盘
  platformMock.js       模拟市级平台（幂等、拒收、503）
  submitter.js          分批上送、重试、崩溃恢复
  routes.js             REST API
  util.js               id/hash/CSV 等工具
public/                 单页前端（原生 JS，hash 路由，轮询）
scripts/gen-sample.js   样本生成
test/e2e.js             端到端测试
```

## 可调环境变量

`PORT`(8080) · `DATA_DIR`(数据目录) · `BATCH_SIZE`(500) · `PLATFORM_DELAY_MS`(120) ·
`PLATFORM_FAIL_RATE`(0.03) · `MOCK_STUDENTS`(6000) · `STORE_FLUSH_MS`(300)
