// 加密/解密模块
// 使用Node.js crypto模块进行数据加密

const crypto = require('crypto');
const { logSecurityEvent } = require('./security-logger');

class CryptoService {
    constructor(encryptionKey) {
        const isKeyBuffer = Buffer.isBuffer(encryptionKey) && encryptionKey.length === 32;
        if (!isKeyBuffer && !CryptoService.isValidKey(encryptionKey)) {
            throw new Error('ENCRYPTION_KEY必须是恰好32字节的可打印ASCII字符');
        }

        this.key = isKeyBuffer ? Buffer.from(encryptionKey) : Buffer.from(encryptionKey, 'ascii');
        this.algorithm = 'aes-256-cbc';
        this.ivLength = 16;
        this.callbackTokenVersion = 1;
        this.callbackEncryptionKey = this.deriveKey('qywx-push/callback-token/encryption/v1');
        this.callbackLookupKey = this.deriveKey('qywx-push/callback-token/lookup/v1');
    }

    static isValidKey(encryptionKey) {
        return typeof encryptionKey === 'string' && /^[\x20-\x7E]{32}$/.test(encryptionKey);
    }

    deriveKey(domain) {
        return crypto.createHmac('sha256', this.key).update(domain, 'utf8').digest();
    }

    // 加密函数
    encrypt(text) {
        try {
            const iv = crypto.randomBytes(this.ivLength);
            const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            // 返回iv:密文
            return iv.toString('hex') + ':' + encrypted;
        } catch (error) {
            logSecurityEvent({ status: 'failed', errorCategory: 'encryption_failed' });
            throw new Error('数据加密失败');
        }
    }

    // 解密函数
    decrypt(encryptedText) {
        try {
            const [ivHex, encrypted] = encryptedText.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            logSecurityEvent({ status: 'failed', errorCategory: 'decryption_failed' });
            throw new Error('数据解密失败');
        }
    }

    // callback token使用带随机IV和认证标签的版本化AES-256-GCM格式。
    encryptCallbackToken(token) {
        if (typeof token !== 'string' || token.length === 0) {
            throw new Error('回调Token不能为空');
        }

        try {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', this.callbackEncryptionKey, iv);
            cipher.setAAD(Buffer.from('qywx-push/callback-token/v1', 'utf8'));
            const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
            const authTag = cipher.getAuthTag();
            return `v1:${iv.toString('base64url')}:${encrypted.toString('base64url')}:${authTag.toString('base64url')}`;
        } catch (error) {
            logSecurityEvent({ status: 'failed', errorCategory: 'encryption_failed' });
            throw new Error('回调Token加密失败');
        }
    }

    decryptCallbackToken(encryptedToken, expectedVersion) {
        try {
            const parts = typeof encryptedToken === 'string' ? encryptedToken.split(':') : [];
            if (parts.length !== 4 || parts[0] !== 'v1') {
                throw new Error('不支持的回调Token密文格式');
            }
            if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== this.callbackTokenVersion) {
                throw new Error('不支持的回调Token密文版本');
            }

            const iv = Buffer.from(parts[1], 'base64url');
            const encrypted = Buffer.from(parts[2], 'base64url');
            const authTag = Buffer.from(parts[3], 'base64url');
            if (iv.length !== 12 || authTag.length !== 16) {
                throw new Error('回调Token密文参数无效');
            }

            const decipher = crypto.createDecipheriv('aes-256-gcm', this.callbackEncryptionKey, iv);
            decipher.setAAD(Buffer.from('qywx-push/callback-token/v1', 'utf8'));
            decipher.setAuthTag(authTag);
            const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
            if (!decrypted) {
                throw new Error('回调Token解密结果为空');
            }
            return decrypted;
        } catch (error) {
            logSecurityEvent({ status: 'failed', errorCategory: 'decryption_failed' });
            throw new Error('回调Token解密失败');
        }
    }

    hashCallbackToken(token) {
        if (typeof token !== 'string' || token.length === 0) {
            return null;
        }
        return crypto.createHmac('sha256', this.callbackLookupKey).update(token, 'utf8').digest('hex');
    }

    getCallbackTokenVersion() {
        return this.callbackTokenVersion;
    }

    // 生成符合运行时约束的32字符高熵密钥
    static generateKey() {
        return crypto.randomBytes(24).toString('base64url');
    }
}

module.exports = CryptoService; 