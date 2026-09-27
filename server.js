'use strict';
const path = require('path');
const express = require('express');
const { createRouter } = require('./src/routes');
const { mountMockPlatform } = require('./src/platformMock');
const { resumeInterruptedTasks } = require('./src/submitter');
const store = require('./src/store');

const app = express();
app.use(express.json());

// API
app.use('/api', createRouter());

// 模拟的市级平台（真实环境是外部系统）
mountMockPlatform(app);

// 前端静态页
app.use(express.static(path.join(__dirname, 'public')));

// 错误处理
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件过大（上限 100MB）' });
  if (err && err.name === 'MulterError') return res.status(400).json({ error: '上传失败：' + err.message });
  const status = err.status || 500;
  console.error('[api] error:', err.message);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, () => {
  console.log(`成绩导入服务已启动: http://localhost:${PORT}`);
  console.log(`模拟市级平台:     http://localhost:${PORT}/mock-platform`);
  resumeInterruptedTasks();
});

function gracefulExit() {
  server.close(() => store.flush());
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

module.exports = app;
