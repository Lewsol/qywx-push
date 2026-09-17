// 核心业务逻辑模块
// 处理配置创建和消息发送的业务逻辑

const nodeCrypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Database = require('../core/database');
const CryptoService = require('../core/crypto');
const WeChatService = require('../core/wechat');
const WeChatCallbackCrypto = require('../core/wechat-callback');
const { summarizeIdentifier } = require('../core/identifier');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../database/notifier.db');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const db = new Database(DB_PATH);
const crypto = new CryptoService(ENCRYPTION_KEY);
const wechat = new WeChatService();
const dbReady = db.init().catch((error) => {
    console.error('数据库初始化失败:', error.message);
    throw error;
});

class ConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConflictError';
        this.code = 'CONFIGURATION_CONFLICT';
    }
}

function createNotifyToken() {
    return nodeCrypto.randomBytes(32).toString('base64url');
}

function isConstraintError(error) {
    return Boolean(error && error.code && error.code.startsWith('SQLITE_CONSTRAINT'));
}

async function createCallbackConfiguration(config) {
    await dbReady;
    const { corpid, callback_token, encoding_aes_key } = config;
    if (!corpid || !callback_token || !encoding_aes_key) {
        throw new Error('回调配置参数不完整');
    }
    if (encoding_aes_key.length !== 43) {
        throw new Error('EncodingAESKey必须是43位字符');
    }

    const existingConfig = await db.getCallbackConfiguration(corpid, callback_token);
    if (existingConfig) {
        console.log('发现重复回调配置, 标识摘要:', summarizeIdentifier(existingConfig.code));
        throw new ConflictError('相同的回调配置已存在');
    }

    const code = uuidv4();
    const notify_token = createNotifyToken();
    const encrypted_encoding_aes_key = crypto.encrypt(encoding_aes_key);

    try {
        await db.saveCallbackConfiguration({
            code,
            notify_token,
            corpid,
            callback_token,
            encrypted_encoding_aes_key
        });
    } catch (error) {
        if (isConstraintError(error)) {
            throw new ConflictError('相同的回调配置已存在');
        }
        throw error;
    }

    console.log('回调配置创建成功, 标识摘要:', summarizeIdentifier(code));
    return {
        code,
        callbackUrl: `/api/callback/${code}`
    };
}

async function completeConfiguration(config) {
    await dbReady;
    const { code, corpsecret, agentid, touser, description } = config;
    if (!code || !corpsecret || !agentid || !touser) {
        throw new Error('参数不完整');
    }

    const callbackConfig = await db.getConfigurationByCode(code);
    if (!callbackConfig) {
        throw new Error('回调配置不存在，请先生成回调URL');
    }

    const encrypted_corpsecret = crypto.encrypt(corpsecret);
    const formattedTouser = Array.isArray(touser) ? touser.join('|') : touser;

    await db.completeConfiguration({
        code,
        encrypted_corpsecret,
        agentid,
        touser: formattedTouser,
        description: description || ''
    });

    console.log('配置完善成功, 标识摘要:', summarizeIdentifier(code));
    return {
        code,
        apiUrl: `/api/notify/${callbackConfig.notify_token}`,
        callbackUrl: `/api/callback/${code}`
    };
}

async function createConfiguration(config) {
    await dbReady;
    const {
        corpid, corpsecret, agentid, touser, description,
        callback_token, encoding_aes_key, callback_enabled
    } = config;
    if (!corpid || !corpsecret || !agentid || !touser) {
        throw new Error('参数不完整');
    }

    if (callback_enabled) {
        if (!callback_token || !encoding_aes_key) {
            throw new Error('启用回调时必须提供回调Token和EncodingAESKey');
        }
        if (encoding_aes_key.length !== 43) {
            throw new Error('EncodingAESKey必须是43位字符');
        }
        console.log('回调配置验证通过，继续处理配置');
    }

    const formattedTouser = Array.isArray(touser) ? touser.join('|') : touser;
    const existingConfig = await db.getConfigurationByCompleteFields(
        corpid,
        agentid,
        formattedTouser,
        callback_enabled ? 1 : 0,
        callback_token || null
    );

    if (existingConfig) {
        console.log('发现重复配置, 标识摘要:', summarizeIdentifier(existingConfig.code));
        throw new ConflictError('相同配置已存在');
    }

    const code = uuidv4();
    const notify_token = createNotifyToken();
    const encrypted_corpsecret = crypto.encrypt(corpsecret);
    const encrypted_encoding_aes_key = encoding_aes_key ? crypto.encrypt(encoding_aes_key) : null;

    try {
        await db.saveConfiguration({
            code,
            notify_token,
            corpid,
            encrypted_corpsecret,
            agentid,
            touser: formattedTouser,
            description: description || '',
            callback_token: callback_token || null,
            encrypted_encoding_aes_key,
            callback_enabled: callback_enabled ? 1 : 0
        });
    } catch (error) {
        if (isConstraintError(error)) {
            throw new ConflictError('相同配置已存在');
        }
        throw error;
    }

    console.log('新配置创建成功, 标识摘要:', summarizeIdentifier(code));
    const result = {
        code,
        apiUrl: `/api/notify/${notify_token}`
    };
    if (callback_enabled) {
        result.callbackUrl = `/api/callback/${code}`;
    }
    return result;
}

async function sendNotification(notifyToken, title, content) {
    await dbReady;
    const config = await db.getConfigurationByNotifyToken(notifyToken);
    if (!config) {
        throw new Error('无效的通知token，未找到配置');
    }
    const corpsecret = crypto.decrypt(config.encrypted_corpsecret);
    const accessToken = await wechat.getToken(config.corpid, corpsecret);
    const message = title ? `${title}\n${content}` : content;
    return wechat.sendMessage(accessToken, config.agentid, config.touser, message);
}

async function getConfiguration(code) {
    await dbReady;
    const config = await db.getConfigurationByCode(code);
    if (!config) return null;

    const result = {
        code: config.code,
        corpid: config.corpid,
        agentid: config.agentid,
        touser: config.touser.split('|'),
        description: config.description,
        callback_enabled: config.callback_enabled === 1,
        created_at: config.created_at,
        apiUrl: `/api/notify/${config.notify_token}`
    };

    if (config.callback_enabled) {
        result.callback_token = config.callback_token;
        result.callbackUrl = `/api/callback/${config.code}`;
    }

    return result;
}

async function updateConfiguration(code, newConfig) {
    await dbReady;
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw new Error('无效的code，未找到配置');
    }

    let encrypted_corpsecret = config.encrypted_corpsecret;
    if (newConfig.corpsecret) {
        encrypted_corpsecret = crypto.encrypt(newConfig.corpsecret);
    }

    let encrypted_encoding_aes_key = config.encrypted_encoding_aes_key;
    if (newConfig.encoding_aes_key) {
        encrypted_encoding_aes_key = crypto.encrypt(newConfig.encoding_aes_key);
    }

    await db.updateConfiguration({
        code,
        corpid: newConfig.corpid || config.corpid,
        encrypted_corpsecret,
        agentid: newConfig.agentid || config.agentid,
        touser: newConfig.touser ? (Array.isArray(newConfig.touser) ? newConfig.touser.join('|') : newConfig.touser) : config.touser,
        description: newConfig.description !== undefined ? newConfig.description : config.description,
        callback_token: newConfig.callback_token !== undefined ? newConfig.callback_token : config.callback_token,
        encrypted_encoding_aes_key,
        callback_enabled: newConfig.callback_enabled !== undefined ? (newConfig.callback_enabled ? 1 : 0) : config.callback_enabled
    });

    const result = {
        message: '配置更新成功',
        code,
        apiUrl: `/api/notify/${config.notify_token}`
    };
    if (newConfig.callback_enabled || config.callback_enabled) {
        result.callbackUrl = `/api/callback/${code}`;
    }
    return result;
}

async function rotateNotifyToken(code) {
    await dbReady;
    const config = await db.getConfigurationByCode(code);
    if (!config) {
        throw new Error('无效的code，未找到配置');
    }

    const notifyToken = createNotifyToken();
    await db.rotateNotifyToken(code, notifyToken);
    console.log('通知token轮换成功, 标识摘要:', summarizeIdentifier(code));
    return {
        code,
        apiUrl: `/api/notify/${notifyToken}`
    };
}

async function handleCallbackVerification(code, msgSignature, timestamp, nonce, echoStr) {
    await dbReady;
    try {
        const config = await db.getConfigurationByCode(code);
        if (!config || !config.callback_enabled) {
            return { success: false, error: '回调未启用或配置不存在' };
        }
        if (!config.callback_token || !config.encrypted_encoding_aes_key) {
            return { success: false, error: '回调配置不完整' };
        }

        const encodingAESKey = crypto.decrypt(config.encrypted_encoding_aes_key);
        const callbackCrypto = new WeChatCallbackCrypto(
            config.callback_token,
            encodingAESKey,
            config.corpid
        );
        return callbackCrypto.verifyURL(msgSignature, timestamp, nonce, echoStr);
    } catch (error) {
        console.error('回调验证失败:', error.message);
        return { success: false, error: error.message };
    }
}

async function handleCallbackMessage(code, encryptedData, msgSignature, timestamp, nonce) {
    await dbReady;
    try {
        const config = await db.getConfigurationByCode(code);
        if (!config || !config.callback_enabled) {
            return { success: false, error: '回调未启用或配置不存在' };
        }
        if (!config.callback_token || !config.encrypted_encoding_aes_key) {
            return { success: false, error: '回调配置不完整' };
        }

        const encodingAESKey = crypto.decrypt(config.encrypted_encoding_aes_key);
        const callbackCrypto = new WeChatCallbackCrypto(
            config.callback_token,
            encodingAESKey,
            config.corpid
        );
        const decryptResult = callbackCrypto.decryptMsg(encryptedData, msgSignature, timestamp, nonce);
        if (!decryptResult.success) {
            return decryptResult;
        }

        const message = callbackCrypto.parseXMLMessage(decryptResult.data);
        console.log(`[回调消息] Code摘要: ${summarizeIdentifier(code)}, 发送者: ${message.fromUserName}, 类型: ${message.msgType}`);
        if (message.msgType === 'text') {
            console.log(`[回调消息] 内容: ${message.content}`);
        }
        return { success: true, message };
    } catch (error) {
        console.error('回调消息处理失败:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    ConflictError,
    createCallbackConfiguration,
    completeConfiguration,
    createConfiguration,
    sendNotification,
    getConfiguration,
    updateConfiguration,
    rotateNotifyToken,
    handleCallbackVerification,
    handleCallbackMessage
};
