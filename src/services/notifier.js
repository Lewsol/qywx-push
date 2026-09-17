// 核心业务逻辑模块
// 处理配置创建和消息发送的业务逻辑

const nodeCrypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Database = require('../core/database');
const CryptoService = require('../core/crypto');
const WeChatService = require('../core/wechat');
const WeChatCallbackCrypto = require('../core/wechat-callback');
const { summarizeIdentifier } = require('../core/identifier');
const { logSecurityEvent } = require('../core/security-logger');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../database/notifier.db');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const crypto = new CryptoService(ENCRYPTION_KEY);
const db = new Database(DB_PATH, crypto);
const wechat = new WeChatService();
const dbReady = db.init().catch((error) => {
    logSecurityEvent({ status: 'failed', errorCategory: 'database_initialization_failed' });
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

    const callback_token_hash = crypto.hashCallbackToken(callback_token);
    const existingConfig = await db.getCallbackConfiguration(corpid, callback_token_hash);
    if (existingConfig) {
        console.log('发现重复回调配置, 标识摘要:', summarizeIdentifier(existingConfig.code));
        throw new ConflictError('相同的回调配置已存在');
    }

    const code = uuidv4();
    const notify_token = createNotifyToken();
    const encrypted_encoding_aes_key = crypto.encrypt(encoding_aes_key);
    const encrypted_callback_token = crypto.encryptCallbackToken(callback_token);

    try {
        await db.saveCallbackConfiguration({
            code,
            notify_token,
            corpid,
            encrypted_callback_token,
            callback_token_hash,
            callback_token_version: crypto.getCallbackTokenVersion(),
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
    const callback_token_hash = callback_token ? crypto.hashCallbackToken(callback_token) : null;
    const existingConfig = await db.getConfigurationByCompleteFields(
        corpid,
        agentid,
        formattedTouser,
        callback_enabled ? 1 : 0,
        callback_token_hash
    );

    if (existingConfig) {
        console.log('发现重复配置, 标识摘要:', summarizeIdentifier(existingConfig.code));
        throw new ConflictError('相同配置已存在');
    }

    const code = uuidv4();
    const notify_token = createNotifyToken();
    const encrypted_corpsecret = crypto.encrypt(corpsecret);
    const encrypted_encoding_aes_key = encoding_aes_key ? crypto.encrypt(encoding_aes_key) : null;
    const encrypted_callback_token = callback_token ? crypto.encryptCallbackToken(callback_token) : null;

    try {
        await db.saveConfiguration({
            code,
            notify_token,
            corpid,
            encrypted_corpsecret,
            agentid,
            touser: formattedTouser,
            description: description || '',
            encrypted_callback_token,
            callback_token_hash,
            callback_token_version: callback_token ? crypto.getCallbackTokenVersion() : null,
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
        result.callback_token_configured = Boolean(config.encrypted_callback_token);
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

    let encrypted_callback_token = config.encrypted_callback_token;
    let callback_token_hash = config.callback_token_hash;
    let callback_token_version = config.callback_token_version;
    if (typeof newConfig.callback_token === 'string' && newConfig.callback_token.length > 0) {
        encrypted_callback_token = crypto.encryptCallbackToken(newConfig.callback_token);
        callback_token_hash = crypto.hashCallbackToken(newConfig.callback_token);
        callback_token_version = crypto.getCallbackTokenVersion();
    }

    await db.updateConfiguration({
        code,
        corpid: newConfig.corpid || config.corpid,
        encrypted_corpsecret,
        agentid: newConfig.agentid || config.agentid,
        touser: newConfig.touser ? (Array.isArray(newConfig.touser) ? newConfig.touser.join('|') : newConfig.touser) : config.touser,
        description: newConfig.description !== undefined ? newConfig.description : config.description,
        encrypted_callback_token,
        callback_token_hash,
        callback_token_version,
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

async function handleCallbackVerification(code, msgSignature, timestamp, nonce, echoStr, requestId) {
    await dbReady;
    const startedAt = Date.now();
    try {
        const config = await db.getConfigurationByCode(code);
        if (!config || !config.callback_enabled) {
            return { success: false, error: 'callback_disabled' };
        }
        if (!config.encrypted_callback_token || !config.encrypted_encoding_aes_key) {
            return { success: false, error: 'callback_configuration_incomplete' };
        }

        const callbackToken = crypto.decryptCallbackToken(
            config.encrypted_callback_token,
            config.callback_token_version
        );
        const encodingAESKey = crypto.decrypt(config.encrypted_encoding_aes_key);
        const callbackCrypto = new WeChatCallbackCrypto(
            callbackToken,
            encodingAESKey,
            config.corpid
        );
        const verification = callbackCrypto.verifyURL(msgSignature, timestamp, nonce, echoStr);
        if (verification.success) {
            logSecurityEvent({
                requestId,
                configRef: code,
                messageType: 'url_verification',
                status: 'success',
                durationMs: Date.now() - startedAt
            });
        }
        return verification;
    } catch (error) {
        return { success: false, error: 'internal_error' };
    }
}

async function handleCallbackMessage(code, encryptedData, msgSignature, timestamp, nonce, requestId) {
    await dbReady;
    const startedAt = Date.now();
    try {
        const config = await db.getConfigurationByCode(code);
        if (!config || !config.callback_enabled) {
            return { success: false, error: 'callback_disabled' };
        }
        if (!config.encrypted_callback_token || !config.encrypted_encoding_aes_key) {
            return { success: false, error: 'callback_configuration_incomplete' };
        }

        const callbackToken = crypto.decryptCallbackToken(
            config.encrypted_callback_token,
            config.callback_token_version
        );
        const encodingAESKey = crypto.decrypt(config.encrypted_encoding_aes_key);
        const callbackCrypto = new WeChatCallbackCrypto(
            callbackToken,
            encodingAESKey,
            config.corpid
        );
        const decryption = callbackCrypto.decryptMsg(encryptedData, msgSignature, timestamp, nonce);
        if (!decryption.success) {
            return { success: false, error: decryption.error };
        }

        const parsedMessage = callbackCrypto.parseXMLMessage(decryption.data);
        const messageType = parsedMessage.msgType || 'unknown';
        const securityRecord = logSecurityEvent({
            requestId,
            configRef: code,
            messageType,
            status: 'success',
            durationMs: Date.now() - startedAt
        });
        return { success: true, messageType: securityRecord.messageType };
    } catch (error) {
        return {
            success: false,
            error: error && error.code === 'MESSAGE_PARSE_FAILED' ? 'message_parse_failed' : 'internal_error'
        };
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
