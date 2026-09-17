// 数据库初始化与操作模块
// 管理SQLite数据库连接和表结构

const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { summarizeIdentifier } = require('./identifier');
const { logSecurityEvent } = require('./security-logger');

class Database {
    constructor(dbPath, cryptoService = null) {
        this.dbPath = dbPath;
        this.cryptoService = cryptoService;
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
                    logSecurityEvent({ status: 'failed', errorCategory: 'database_connection_failed' });
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
                encrypted_callback_token TEXT,
                callback_token_hash TEXT,
                callback_token_version INTEGER,
                encrypted_encoding_aes_key TEXT,
                callback_enabled BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(corpid, agentid, touser)
            )
        `;

        const callbackPurgeMigration = 'callback_token_secure_purge_v1';
        const notifyTokenMigration = 'notify_token_separation_v2';
        let transactionStarted = false;
        let needsSecurePurge = false;
        try {
            await this.run('PRAGMA secure_delete = ON');
            await this.run('BEGIN IMMEDIATE TRANSACTION');
            transactionStarted = true;
            const existingTables = await this.all(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'configurations'"
            );
            const configurationsExisted = existingTables.length === 1;
            await this.run(createTableSQL);
            await this.run(`
                CREATE TABLE IF NOT EXISTS security_migrations (
                    name TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            const columns = await this.all('PRAGMA table_info(configurations)');
            const columnNames = new Set(columns.map((column) => column.name));
            const newColumns = [
                ['notify_token', 'TEXT'],
                ['encrypted_callback_token', 'TEXT'],
                ['callback_token_hash', 'TEXT'],
                ['callback_token_version', 'INTEGER']
            ];
            for (const [columnName, columnType] of newColumns) {
                if (!columnNames.has(columnName)) {
                    await this.run(`ALTER TABLE configurations ADD COLUMN ${columnName} ${columnType}`);
                }
            }

            const notifyTokenStatus = await this.get(
                'SELECT status FROM security_migrations WHERE name = ?',
                [notifyTokenMigration]
            );
            if (!notifyTokenStatus || notifyTokenStatus.status !== 'complete') {
                if (configurationsExisted) {
                    const legacyConfigurations = await this.all('SELECT id FROM configurations ORDER BY id');
                    for (const configuration of legacyConfigurations) {
                        await this.run(
                            'UPDATE configurations SET notify_token = ? WHERE id = ?',
                            [crypto.randomBytes(32).toString('base64url'), configuration.id]
                        );
                    }
                }
                await this.run(
                    `INSERT INTO security_migrations (name, status, updated_at)
                     VALUES (?, 'complete', CURRENT_TIMESTAMP)
                     ON CONFLICT(name) DO UPDATE SET status = 'complete', updated_at = CURRENT_TIMESTAMP`,
                    [notifyTokenMigration]
                );
            }

            const purgeStatus = await this.get(
                'SELECT status FROM security_migrations WHERE name = ?',
                [callbackPurgeMigration]
            );
            needsSecurePurge = !purgeStatus || purgeStatus.status !== 'complete';
            if (needsSecurePurge) {
                await this.run(
                    `INSERT INTO security_migrations (name, status, updated_at)
                     VALUES (?, 'pending', CURRENT_TIMESTAMP)
                     ON CONFLICT(name) DO UPDATE SET status = 'pending', updated_at = CURRENT_TIMESTAMP`,
                    [callbackPurgeMigration]
                );
            }

            await this.migrateCallbackTokens();
            await this.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_configurations_notify_token ON configurations(notify_token)');
            await this.run('CREATE INDEX IF NOT EXISTS idx_configurations_callback_lookup ON configurations(corpid, callback_enabled, callback_token_hash)');
            await this.run('CREATE INDEX IF NOT EXISTS idx_configurations_complete_lookup ON configurations(corpid, agentid, touser, callback_enabled, callback_token_hash)');
            await this.run('COMMIT');
            transactionStarted = false;

            if (needsSecurePurge) {
                // VACUUM必须在事务外执行；迁移标记仅在清理完成后置为complete，失败可在下次启动重试。
                const checkpoint = await this.get('PRAGMA wal_checkpoint(TRUNCATE)');
                if (!checkpoint || Number(checkpoint.busy) !== 0) {
                    throw new Error('WAL仍被其他连接占用，回调Token安全清理未完成');
                }
                await this.run('VACUUM');
                await this.run(
                    `UPDATE security_migrations
                     SET status = 'complete', updated_at = CURRENT_TIMESTAMP
                     WHERE name = ?`,
                    [callbackPurgeMigration]
                );
            }
            console.log('数据表创建及迁移成功');
        } catch (err) {
            if (transactionStarted) {
                try {
                    await this.run('ROLLBACK');
                } catch (rollbackError) {
                    logSecurityEvent({ status: 'failed', errorCategory: 'database_migration_failed' });
                }
            }
            logSecurityEvent({ status: 'failed', errorCategory: 'database_migration_failed' });
            throw err;
        }
    }

    async migrateCallbackTokens() {
        const rows = await this.all(`
            SELECT id, callback_token, encrypted_callback_token,
                   callback_token_hash, callback_token_version,
                   encrypted_corpsecret, encrypted_encoding_aes_key
            FROM configurations
            WHERE callback_token IS NOT NULL
               OR encrypted_callback_token IS NOT NULL
               OR callback_token_hash IS NOT NULL
               OR callback_token_version IS NOT NULL
            ORDER BY id
        `);
        if (rows.length > 0 && !this.cryptoService) {
            throw new Error('回调Token迁移需要加密服务');
        }

        for (const row of rows) {
            const plaintextToken = typeof row.callback_token === 'string' && row.callback_token.length > 0
                ? row.callback_token
                : null;
            let token = null;
            let encryptedToken = row.encrypted_callback_token;

            if (encryptedToken) {
                token = this.cryptoService.decryptCallbackToken(encryptedToken, row.callback_token_version);
                if (plaintextToken !== null && plaintextToken !== token) {
                    throw new Error(`记录 ${row.id} 的回调Token明文与密文不一致`);
                }
            } else if (plaintextToken !== null) {
                this.validateCallbackMigrationKey(row);
                token = plaintextToken;
                encryptedToken = this.cryptoService.encryptCallbackToken(token);
            } else if (row.callback_token_hash !== null || row.callback_token_version !== null) {
                throw new Error(`记录 ${row.id} 的回调Token迁移状态不完整`);
            }

            const tokenHash = token === null ? null : this.cryptoService.hashCallbackToken(token);
            const tokenVersion = token === null ? null : this.cryptoService.getCallbackTokenVersion();
            if (token !== null && this.cryptoService.decryptCallbackToken(encryptedToken, tokenVersion) !== token) {
                throw new Error(`记录 ${row.id} 的回调Token迁移校验失败`);
            }

            await this.run(
                `UPDATE configurations
                 SET callback_token = NULL, encrypted_callback_token = ?,
                     callback_token_hash = ?, callback_token_version = ?
                 WHERE id = ?`,
                [encryptedToken || null, tokenHash, tokenVersion, row.id]
            );
        }
    }

    validateCallbackMigrationKey(row) {
        let validatedFields = 0;
        if (row.encrypted_corpsecret) {
            const corpSecret = this.cryptoService.decrypt(row.encrypted_corpsecret);
            if (!/^[A-Za-z0-9_-]{43}$/.test(corpSecret)) {
                throw new Error(`记录 ${row.id} 的 CorpSecret 无法通过迁移校验`);
            }
            validatedFields += 1;
        }
        if (row.encrypted_encoding_aes_key) {
            const encodingAESKey = this.cryptoService.decrypt(row.encrypted_encoding_aes_key);
            if (!/^[A-Za-z0-9]{43}$/.test(encodingAESKey)) {
                throw new Error(`记录 ${row.id} 的 EncodingAESKey 无法通过迁移校验`);
            }
            validatedFields += 1;
        }
        if (validatedFields === 0) {
            throw new Error(`记录 ${row.id} 缺少可用于验证加密密钥的字段`);
        }
    }

    async saveConfiguration(config) {
        const {
            code, notify_token, corpid, encrypted_corpsecret, agentid, touser, description,
            encrypted_callback_token, callback_token_hash, callback_token_version,
            encrypted_encoding_aes_key, callback_enabled
        } = config;
        const sql = `
            INSERT INTO configurations (
                code, notify_token, corpid, encrypted_corpsecret, agentid, touser, description,
                callback_token, encrypted_callback_token, callback_token_hash, callback_token_version,
                encrypted_encoding_aes_key, callback_enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        `;

        try {
            const result = await this.run(sql, [
                code, notify_token, corpid, encrypted_corpsecret, agentid, touser, description,
                encrypted_callback_token, callback_token_hash, callback_token_version,
                encrypted_encoding_aes_key, callback_enabled || 0
            ]);
            console.log('配置保存成功, ID:', result.lastID);
            return { id: result.lastID, code };
        } catch (err) {
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
            throw err;
        }
    }

    async getConfigurationByCode(code) {
        try {
            const row = await this.get('SELECT * FROM configurations WHERE code = ?', [code]);
            if (row && row.notify_token === null) {
                const notifyToken = crypto.randomBytes(32).toString('base64url');
                const updateResult = await this.run(
                    'UPDATE configurations SET notify_token = ? WHERE id = ? AND notify_token IS NULL',
                    [notifyToken, row.id]
                );
                if (updateResult.changes > 0) {
                    row.notify_token = notifyToken;
                } else {
                    const current = await this.get('SELECT notify_token FROM configurations WHERE id = ?', [row.id]);
                    row.notify_token = current ? current.notify_token : null;
                }
            }
            return row;
        } catch (err) {
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
            throw err;
        }
    }

    async getConfigurationByNotifyToken(notifyToken) {
        try {
            return await this.get(
                'SELECT * FROM configurations WHERE notify_token = ?',
                [notifyToken]
            );
        } catch (err) {
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
            throw err;
        }
    }

    async updateConfiguration(config) {
        const {
            code, corpid, encrypted_corpsecret, agentid, touser, description,
            encrypted_callback_token, callback_token_hash, callback_token_version,
            encrypted_encoding_aes_key, callback_enabled
        } = config;
        const sql = `
            UPDATE configurations
            SET corpid = ?, encrypted_corpsecret = ?, agentid = ?, touser = ?, description = ?,
                callback_token = NULL, encrypted_callback_token = ?, callback_token_hash = ?,
                callback_token_version = ?, encrypted_encoding_aes_key = ?, callback_enabled = ?
            WHERE code = ?
        `;

        try {
            await this.run(sql, [
                corpid, encrypted_corpsecret, agentid, touser, description,
                encrypted_callback_token, callback_token_hash, callback_token_version,
                encrypted_encoding_aes_key, callback_enabled, code
            ]);
            console.log('配置更新成功, 标识摘要:', summarizeIdentifier(code));
            return { code };
        } catch (err) {
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
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
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
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
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
            throw err;
        }
    }

    async getConfigurationByCompleteFields(corpid, agentid, touser, callback_enabled, callbackTokenHash) {
        const sql = 'SELECT * FROM configurations WHERE corpid = ? AND agentid = ? AND touser = ? AND callback_enabled = ? AND (callback_token_hash = ? OR (callback_token_hash IS NULL AND ? IS NULL))';
        try {
            return await this.get(sql, [corpid, agentid, touser, callback_enabled, callbackTokenHash, callbackTokenHash]);
        } catch (err) {
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
            throw err;
        }
    }

    async saveCallbackConfiguration(config) {
        const {
            code, notify_token, corpid, encrypted_callback_token,
            callback_token_hash, callback_token_version, encrypted_encoding_aes_key
        } = config;
        const sql = `
            INSERT INTO configurations (
                code, notify_token, corpid, callback_token, encrypted_callback_token,
                callback_token_hash, callback_token_version, encrypted_encoding_aes_key,
                callback_enabled, encrypted_corpsecret, agentid, touser, description
            )
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, '', 0, '', '')
        `;

        try {
            const result = await this.run(sql, [
                code, notify_token, corpid, encrypted_callback_token,
                callback_token_hash, callback_token_version, encrypted_encoding_aes_key
            ]);
            console.log('回调配置保存成功, ID:', result.lastID);
            return { id: result.lastID, code };
        } catch (err) {
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
            throw err;
        }
    }

    async getCallbackConfiguration(corpid, callbackTokenHash) {
        try {
            return await this.get(
                'SELECT * FROM configurations WHERE corpid = ? AND callback_token_hash = ? AND callback_enabled = 1',
                [corpid, callbackTokenHash]
            );
        } catch (err) {
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
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
            logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
            throw err;
        }
    }

    async close() {
        if (!this.db) return;
        await new Promise((resolve, reject) => {
            this.db.close((err) => {
                if (err) {
                    logSecurityEvent({ status: 'failed', errorCategory: 'database_operation_failed' });
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
