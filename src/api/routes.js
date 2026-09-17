// Express路由定义
// 包含所有API端点的路由配置

const express = require('express');
const path = require('path');
const { requireAdmin } = require('../core/admin-auth');
const notifier = require('../services/notifier');
const WeChatService = require('../core/wechat');

const router = express.Router();
const wechat = new WeChatService();

function isConflict(error) {
    return error && error.code === 'CONFIGURATION_CONFLICT';
}

router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
});

router.post('/api/validate', requireAdmin, async (req, res) => {
    const { corpid, corpsecret } = req.body;
    if (!corpid || !corpsecret) {
        return res.status(400).json({ error: '参数不完整' });
    }
    try {
        const accessToken = await wechat.getToken(corpid, corpsecret);
        const users = await wechat.getAllUsers(accessToken);
        res.json({ users });
    } catch (err) {
        res.status(400).json({ error: err.message || '凭证无效或API请求失败' });
    }
});

router.post('/api/generate-callback', requireAdmin, async (req, res) => {
    const { corpid, callback_token, encoding_aes_key } = req.body;
    if (!corpid || !callback_token || !encoding_aes_key) {
        return res.status(400).json({ error: '回调配置参数不完整' });
    }
    if (encoding_aes_key.length !== 43) {
        return res.status(400).json({ error: 'EncodingAESKey必须是43位字符' });
    }
    try {
        const result = await notifier.createCallbackConfiguration({
            corpid,
            callback_token,
            encoding_aes_key
        });
        res.json(result);
    } catch (err) {
        if (isConflict(err)) {
            return res.status(409).json({ error: err.message });
        }
        res.status(500).json({ error: err.message || '生成回调URL失败' });
    }
});

router.post('/api/complete-config', requireAdmin, async (req, res) => {
    try {
        const { code, corpsecret, agentid, touser, description } = req.body;
        const result = await notifier.completeConfiguration({ code, corpsecret, agentid, touser, description });
        res.status(201).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message || '完善配置失败' });
    }
});

router.post('/api/configure', requireAdmin, async (req, res) => {
    try {
        const {
            corpid, corpsecret, agentid, touser, description,
            callback_token, encoding_aes_key, callback_enabled
        } = req.body;
        const result = await notifier.createConfiguration({
            corpid,
            corpsecret,
            agentid,
            touser,
            description,
            callback_token,
            encoding_aes_key,
            callback_enabled
        });
        res.status(201).json(result);
    } catch (err) {
        if (isConflict(err)) {
            return res.status(409).json({ error: err.message });
        }
        res.status(500).json({ error: err.message || '配置保存失败' });
    }
});

// 通知token只具备发送权限，不需要管理员token。
router.post('/api/notify/:token', async (req, res) => {
    const { token } = req.params;
    const { title, content } = req.body;
    if (!content) {
        return res.status(400).json({ error: '消息内容不能为空' });
    }
    try {
        const result = await notifier.sendNotification(token, title, content);
        res.json({ message: '发送成功', response: result });
    } catch (err) {
        if (err.message && err.message.includes('未找到配置')) {
            res.status(404).json({ error: err.message });
        } else {
            res.status(500).json({ error: err.message || '消息发送失败' });
        }
    }
});

router.get('/api/configuration/:code', requireAdmin, async (req, res) => {
    const { code } = req.params;
    try {
        const config = await notifier.getConfiguration(code);
        if (!config) {
            return res.status(404).json({ error: '未找到配置' });
        }
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message || '获取配置失败' });
    }
});

router.put('/api/configuration/:code', requireAdmin, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.updateConfiguration(code, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message || '更新配置失败' });
    }
});

router.post('/api/configuration/:code/rotate-notify-token', requireAdmin, async (req, res) => {
    const { code } = req.params;
    try {
        const result = await notifier.rotateNotifyToken(code);
        res.json(result);
    } catch (err) {
        if (err.message && err.message.includes('未找到配置')) {
            return res.status(404).json({ error: '未找到配置' });
        }
        res.status(500).json({ error: err.message || '轮换通知token失败' });
    }
});

// 企业微信回调继续使用稳定code，不需要管理员token。
router.get('/api/callback/:code', async (req, res) => {
    const { code } = req.params;
    const { msg_signature, timestamp, nonce, echostr } = req.query;

    if (!msg_signature || !timestamp || !nonce || !echostr) {
        return res.status(400).json({ error: '缺少必要的验证参数' });
    }

    try {
        const result = await notifier.handleCallbackVerification(code, msg_signature, timestamp, nonce, echostr);
        if (result.success) {
            res.send(result.data);
        } else {
            console.error('回调验证失败:', result.error);
            res.status(400).send('failed');
        }
    } catch (err) {
        console.error('回调验证异常:', err.message);
        res.status(500).send('failed');
    }
});

router.post('/api/callback/:code', async (req, res) => {
    const { code } = req.params;
    const { msg_signature, timestamp, nonce } = req.query;

    if (!msg_signature || !timestamp || !nonce) {
        return res.status(400).json({ error: '缺少必要的验证参数' });
    }

    try {
        const encryptedData = req.body ? req.body.toString('utf8') : '';
        if (!encryptedData) {
            return res.status(400).json({ error: '消息数据为空' });
        }

        const result = await notifier.handleCallbackMessage(code, encryptedData, msg_signature, timestamp, nonce);
        if (result.success) {
            console.log('回调消息处理成功:', result.message);
            res.send('ok');
        } else {
            console.error('回调消息处理失败:', result.error);
            res.status(400).send('failed');
        }
    } catch (err) {
        console.error('回调消息处理异常:', err.message);
        res.status(500).send('failed');
    }
});

module.exports = router;
