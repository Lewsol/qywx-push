// 数据库初始化与操作模块
// 管理SQLite数据库连接和表结构

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { summarizeIdentifier } = require('./identifier');

class Database {
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.db = null;
    }

    async init() {
        const dbDir = path.dirname(this.dbPath);
        const fs = require('fs');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        await new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('数据库连接失败:', err.message);
                    reject(err);
                    return;
                }
                this.db.configure('busyTimeout', 5000);
                console.log('SQLite数据库连接成功');
                resolve();
            });
        });

        await this.createTables();
    }

    async run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({ lastID: this.lastID, changes: this.changes });
            });
        });
    }

    async get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(row);
            });
        });
    }

    async all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(rows);
            });
        });
    }

    // 创建数据表并在写锁事务内兼容迁移已有SQLite数据库
    async createTables() {
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS configurations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE NOT NULL,
                notify_token TEXT,
                corpid TEXT NOT NULL,
                encrypted_corpsecret TEXT NOT NULL,
                agentid INTEGER NOT NULL,
                touser TEXT NOT NULL,
                description TEXT,
                callback_token TEXT,
                encrypted_encoding_aes_key TEXT,
                callback_enabled BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(corpid, agentid, touser)
            )
        `;

        let transactionStarted = false;
        try {
            await this.run('BEGIN IMMEDIATE TRANSACTION');
            transactionStarted = true;
            await this.run(createTableSQL);
            const columns = await this.all('PRAGMA table_info(configurations)');
            if (!columns.some((column) => column.name === 'notify_token')) {
                await this.run('ALTER TABLE configurations ADD COLUMN notify_token TEXT');
            }
            // 旧版通知URL继续有效：迁移后通知token与原code相同。
            await this.run('UPDATE configurations SET notify_token = code WHERE notify_token IS NULL');
            await this.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_configurations_notify_token ON configurations(notify_token)');
            await this.run('COMMIT');
            transactionStarted = false;
            console.log('数据表创建及迁移成功');
        } catch (err) {
            if (transactionStarted) {
                try {
                    await this.run('ROLLBACK');
                } catch (rollbackError) {
                    console.error('数据库迁移回滚失败:', rollbackError.message);
                }
            }
            console.error('创建或迁移数据表失败:', err.message);
            throw err;
        }
    }

    async saveConfiguration(config) {
        const {
            code, notify_token, corpid, encrypted_corpsecret, agentid, touser, description,
            callback_token, encrypted_encoding_aes_key, callback_enabled
        } = config;
        const sql = `
            INSERT INTO configurations (
                code, notify_token, corpid, encrypted_corpsecret, agentid, touser, description,
                callback_token, encrypted_encoding_aes_key, callback_enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        try {
            const result = await this.run(sql, [
                code, notify_token, corpid, encrypted_corpsecret, agentid, touser, description,
                callback_token, encrypted_encoding_aes_key, callback_enabled || 0
            ]);
            console.log('配置保存成功, ID:', result.lastID);
            return { id: result.lastID, code };
        } catch (err) {
            console.error('保存配置失败:', err.message);
            throw err;
        }
    }

    async getConfigurationByCode(code) {
        try {
            const row = await this.get('SELECT * FROM configurations WHERE code = ?', [code]);
            if (row && row.notify_token === null) {
                await this.run(
                    'UPDATE configurations SET notify_token = code WHERE id = ? AND notify_token IS NULL',
                    [row.id]
                );
                row.notify_token = row.code;
            }
            return row;
        } catch (err) {
            console.error('查询配置失败:', err.message);
            throw err;
        }
    }

    async getConfigurationByNotifyToken(notifyToken) {
        try {
            const row = await this.get(
                'SELECT * FROM configurations WHERE notify_token = ? OR (notify_token IS NULL AND code = ?)',
                [notifyToken, notifyToken]
            );
            // 滚动升级期间旧实例可能继续写入NULL；命中旧code时安全地补写兼容token。
            if (row && row.notify_token === null) {
                await this.run(
                    'UPDATE configurations SET notify_token = code WHERE id = ? AND notify_token IS NULL',
                    [row.id]
                );
                row.notify_token = row.code;
            }
            return row;
        } catch (err) {
            console.error('查询通知配置失败:', err.message);
            throw err;
        }
    }

    async updateConfiguration(config) {
        const {
            code, corpid, encrypted_corpsecret, agentid, touser, description,
            callback_token, encrypted_encoding_aes_key, callback_enabled
        } = config;
        const sql = `
            UPDATE configurations
            SET corpid = ?, encrypted_corpsecret = ?, agentid = ?, touser = ?, description = ?,
                callback_token = ?, encrypted_encoding_aes_key = ?, callback_enabled = ?
            WHERE code = ?
        `;

        try {
            await this.run(sql, [
                corpid, encrypted_corpsecret, agentid, touser, description,
                callback_token, encrypted_encoding_aes_key, callback_enabled, code
            ]);
            console.log('配置更新成功, 标识摘要:', summarizeIdentifier(code));
            return { code };
        } catch (err) {
            console.error('更新配置失败:', err.message);
            throw err;
        }
    }

    async rotateNotifyToken(code, notifyToken) {
        try {
            const result = await this.run(
                'UPDATE configurations SET notify_token = ? WHERE code = ?',
                [notifyToken, code]
            );
            return result.changes > 0;
        } catch (err) {
            console.error('轮换通知token失败:', err.message);
            throw err;
        }
    }

    async getConfigurationByFields(corpid, agentid, touser) {
        try {
            return await this.get(
                'SELECT * FROM configurations WHERE corpid = ? AND agentid = ? AND touser = ?',
                [corpid, agentid, touser]
            );
        } catch (err) {
            console.error('查询配置失败:', err.message);
            throw err;
        }
    }

    async getConfigurationByCompleteFields(corpid, agentid, touser, callback_enabled, callback_token) {
        const sql = 'SELECT * FROM configurations WHERE corpid = ? AND agentid = ? AND touser = ? AND callback_enabled = ? AND (callback_token = ? OR (callback_token IS NULL AND ? IS NULL))';
        try {
            return await this.get(sql, [corpid, agentid, touser, callback_enabled, callback_token, callback_token]);
        } catch (err) {
            console.error('查询完整配置失败:', err.message);
            throw err;
        }
    }

    async saveCallbackConfiguration(config) {
        const { code, notify_token, corpid, callback_token, encrypted_encoding_aes_key } = config;
        const sql = `
            INSERT INTO configurations (
                code, notify_token, corpid, callback_token, encrypted_encoding_aes_key, callback_enabled,
                encrypted_corpsecret, agentid, touser, description
            )
            VALUES (?, ?, ?, ?, ?, 1, '', 0, '', '')
        `;

        try {
            const result = await this.run(sql, [code, notify_token, corpid, callback_token, encrypted_encoding_aes_key]);
            console.log('回调配置保存成功, ID:', result.lastID);
            return { id: result.lastID, code };
        } catch (err) {
            console.error('保存回调配置失败:', err.message);
            throw err;
        }
    }

    async getCallbackConfiguration(corpid, callback_token) {
        try {
            return await this.get(
                'SELECT * FROM configurations WHERE corpid = ? AND callback_token = ? AND callback_enabled = 1',
                [corpid, callback_token]
            );
        } catch (err) {
            console.error('查询回调配置失败:', err.message);
            throw err;
        }
    }

    async completeConfiguration(config) {
        const { code, encrypted_corpsecret, agentid, touser, description } = config;
        const sql = `
            UPDATE configurations
            SET encrypted_corpsecret = ?, agentid = ?, touser = ?, description = ?
            WHERE code = ?
        `;

        try {
            await this.run(sql, [encrypted_corpsecret, agentid, touser, description, code]);
            console.log('配置完善成功, 标识摘要:', summarizeIdentifier(code));
            return { code };
        } catch (err) {
            console.error('完善配置失败:', err.message);
            throw err;
        }
    }

    async close() {
        if (!this.db) return;
        await new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) {
                    console.error('关闭数据库失败:', err.message);
                    reject(err);
                    return;
                }
                resolve();
            });
        });
        this.db = null;
        console.log('数据库连接已关闭');
    }
}

module.exports = Database;
