// 加密/解密模块
// 使用Node.js crypto模块进行数据加密

const crypto = require('crypto');

class CryptoService {
    constructor(encryptionKey) {
        if (!CryptoService.isValidKey(encryptionKey)) {
            throw new Error('ENCRYPTION_KEY必须是恰好32字节的可打印ASCII字符');
        }

        this.key = Buffer.from(encryptionKey, 'ascii');
        this.algorithm = 'aes-256-cbc';
        this.ivLength = 16;
    }

    static isValidKey(encryptionKey) {
        return typeof encryptionKey === 'string' && /^[\x20-\x7E]{32}$/.test(encryptionKey);
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
            console.error('加密失败:', error.message);
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
            console.error('解密失败:', error.message);
            throw new Error('数据解密失败');
        }
    }

    // 生成符合运行时约束的32字符高熵密钥
    static generateKey() {
        return crypto.randomBytes(24).toString('base64url');
    }
}

module.exports = CryptoService; 