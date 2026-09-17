// 企业微信通知转发服务 - 主入口文件
// 作者: AI Assistant
// 创建时间: 2025-01-05

require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('express').json;
const { requireAdmin } = require('./src/core/admin-auth');
const { createHttpsBoundary, readTrustedProxies } = require('./src/core/https-boundary');
const { securityHeaders } = require('./src/core/security-headers');
const routes = require('./src/api/routes');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// 默认只信任环回代理；其他拓扑必须显式提供最小化的IP/CIDR列表。
app.set('trust proxy', readTrustedProxies());

// 所有页面和API响应都使用同一组严格安全头；不允许内联脚本、内联样式或动态求值。
app.use(securityHeaders);

// HTTPS边界必须先于认证和任何body parser，明文非安全方法不会读取敏感请求体。
app.use(createHttpsBoundary());

// 为回调接口使用原始文本解析器
app.use('/api/callback', express.raw({ type: 'text/xml' }));
app.use('/api/callback', express.raw({ type: 'application/xml' }));
app.use('/api/callback', express.raw({ type: 'text/plain' }));

// 管理接口先认证再读取/解析请求体，未认证请求统一返回401。
app.use('/api/validate', requireAdmin);
app.use('/api/generate-callback', requireAdmin);
app.use('/api/complete-config', requireAdmin);
app.use('/api/configure', requireAdmin);
app.use('/api/configuration', requireAdmin);

// 解析JSON请求体（其他接口）
app.use(bodyParser());

// 静态资源服务
app.use('/public', express.static(path.join(__dirname, 'public')));

// 路由
app.use('/', routes);

// 404处理
app.use((req, res) => {
    res.status(404).json({ error: '未找到资源' });
});

// 启动服务器
app.listen(PORT, HOST, () => {
    console.log(`企业微信通知服务已启动，监听: ${HOST}:${PORT}`);
});
