#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const CryptoService = require('../src/core/crypto');

// 轮换备份从创建时起即只允许当前服务账号访问。
process.umask(0o077);

const REQUIRED_COLUMNS = [
    'encrypted_corpsecret',
    'encrypted_encoding_aes_key'
];

const CALLBACK_TOKEN_COLUMNS = [
    'encrypted_callback_token',
    'callback_token_hash',
    'callback_token_version'
];

const PLAINTEXT_VALIDATORS = {
    encrypted_corpsecret(value) {
        return /^[A-Za-z0-9_-]{43}$/.test(value);
    },
    encrypted_encoding_aes_key(value) {
        return /^[A-Za-z0-9]{43}$/.test(value);
    }
};

function getLegacyKey(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('必须通过OLD_ENCRYPTION_KEY提供旧密钥');
    }

    // 仅在轮换时复现旧版本的补齐/截断语义，以便迁移历史密文。
    const key = Buffer.from(value.padEnd(32, '0').slice(0, 32));
    if (key.length !== 32) {
        throw new Error('旧密钥按历史规则处理后不是32字节，无法迁移');
    }
    return key;
}

function decryptLegacy(encryptedText, key) {
    const parts = typeof encryptedText === 'string' ? encryptedText.split(':') : [];
    if (parts.length !== 2 || !/^[0-9a-fA-F]{32}$/.test(parts[0]) || !/^[0-9a-fA-F]+$/.test(parts[1])) {
        throw new Error('发现格式无效的历史密文');
    }

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(parts[0], 'hex'));
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function openDatabase(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, (error) => {
            if (error) {
                reject(error);
                return;
            }
            db.configure('busyTimeout', 5000);
            resolve(db);
        });
    });
}

function closeDatabase(db) {
    return new Promise((resolve, reject) => {
        db.close((error) => error ? reject(error) : resolve());
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(error) {
            if (error) {
                reject(error);
                return;
            }
            resolve(this);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function backupDatabase(db, destination) {
    return new Promise((resolve, reject) => {
        const backup = db.backup(destination);
        backup.step(-1, (stepError) => {
            backup.finish((finishError) => {
                const error = stepError || finishError;
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    });
}

function defaultBackupPath(dbPath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDirectory = path.resolve(__dirname, '../../qywx-push-backups');
    return path.join(backupDirectory, `${path.basename(dbPath)}.backup-${timestamp}`);
}

function isPathInside(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertBackupOutsideProject(backupPath) {
    const projectRoot = fs.realpathSync(path.resolve(__dirname, '..'));
    const backupDirectory = fs.realpathSync(path.dirname(backupPath));
    if (isPathInside(projectRoot, backupDirectory)) {
        throw new Error('BACKUP_PATH必须位于项目目录之外，避免备份进入Git提交或Docker构建上下文');
    }
}

function ensureBackupDestinationSecurity() {
    if (process.platform === 'win32' && process.env.WINDOWS_BACKUP_ACL_CONFIRMED !== '1') {
        throw new Error('Windows轮换前必须为备份目录配置仅服务账号可访问的ACL，并设置WINDOWS_BACKUP_ACL_CONFIRMED=1');
    }
}

function restrictBackupPermissions(backupPath) {
    if (process.platform === 'win32') {
        console.warn('Windows备份文件将继承目录ACL；请确认该目录仅服务账号可访问。');
        return;
    }

    fs.chmodSync(backupPath, 0o600);
}

async function rotate() {
    const oldKey = getLegacyKey(process.env.OLD_ENCRYPTION_KEY);
    const newKeyValue = process.env.NEW_ENCRYPTION_KEY;
    const oldCrypto = new CryptoService(oldKey);
    const newCrypto = new CryptoService(newKeyValue);

    if (oldKey.equals(Buffer.from(newKeyValue, 'ascii'))) {
        throw new Error('新密钥必须与旧密钥不同');
    }

    const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, '../database/notifier.db'));
    const backupPath = path.resolve(process.env.BACKUP_PATH || defaultBackupPath(dbPath));

    if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
        throw new Error(`数据库文件不存在: ${dbPath}`);
    }
    if (fs.existsSync(backupPath)) {
        throw new Error(`备份文件已存在，拒绝覆盖: ${backupPath}`);
    }

    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    assertBackupOutsideProject(backupPath);
    ensureBackupDestinationSecurity();

    let db;
    let transactionStarted = false;
    let rotationCommitted = false;
    try {
        db = await openDatabase(dbPath);

        const columns = await all(db, 'PRAGMA table_info(configurations)');
        const columnNames = new Set(columns.map((column) => column.name));
        for (const column of REQUIRED_COLUMNS) {
            if (!columnNames.has(column)) {
                throw new Error(`数据库缺少必要字段: ${column}`);
            }
        }
        const callbackColumnCount = CALLBACK_TOKEN_COLUMNS.filter((column) => columnNames.has(column)).length;
        if (callbackColumnCount > 0 && callbackColumnCount !== CALLBACK_TOKEN_COLUMNS.length) {
            throw new Error('数据库中的回调Token加密字段不完整，请先使用当前密钥启动服务完成迁移');
        }
        const hasCallbackTokenColumns = callbackColumnCount === CALLBACK_TOKEN_COLUMNS.length;
        if (hasCallbackTokenColumns) {
            const migrationTables = await all(
                db,
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'security_migrations'"
            );
            if (migrationTables.length !== 1) {
                throw new Error('回调Token安全清理状态缺失，请先使用旧密钥启动当前版本完成迁移');
            }
            const purgeStatuses = await all(
                db,
                "SELECT status FROM security_migrations WHERE name = 'callback_token_secure_purge_v1'"
            );
            if (purgeStatuses.length !== 1 || purgeStatuses[0].status !== 'complete') {
                throw new Error('回调Token安全清理尚未完成，请先使用旧密钥启动当前版本完成迁移');
            }
        }

        await backupDatabase(db, backupPath);
        restrictBackupPermissions(backupPath);
        console.log(`数据库已备份到: ${backupPath}`);

        await run(db, 'BEGIN IMMEDIATE TRANSACTION');
        transactionStarted = true;

        const callbackSelect = hasCallbackTokenColumns
            ? ', callback_token, encrypted_callback_token, callback_token_hash, callback_token_version'
            : '';
        const rows = await all(
            db,
            `SELECT id, encrypted_corpsecret, encrypted_encoding_aes_key${callbackSelect}
             FROM configurations
             ORDER BY id`
        );

        let rotatedFields = 0;
        for (const row of rows) {
            const updates = {};
            for (const column of REQUIRED_COLUMNS) {
                const encryptedValue = row[column];
                if (encryptedValue === null || encryptedValue === '') {
                    continue;
                }

                const plaintext = decryptLegacy(encryptedValue, oldKey);
                if (!PLAINTEXT_VALIDATORS[column](plaintext)) {
                    throw new Error(`记录 ${row.id} 的 ${column} 无法通过格式校验，请确认旧密钥正确且数据未损坏`);
                }
                const reencrypted = newCrypto.encrypt(plaintext);
                if (newCrypto.decrypt(reencrypted) !== plaintext) {
                    throw new Error(`记录 ${row.id} 的 ${column} 重加密校验失败`);
                }
                updates[column] = reencrypted;
                rotatedFields += 1;
            }

            if (hasCallbackTokenColumns) {
                if (row.callback_token !== null) {
                    throw new Error(`记录 ${row.id} 仍含回调Token明文，请先使用旧密钥启动当前版本完成安全迁移`);
                }

                if (row.encrypted_callback_token) {
                    if (Number(row.callback_token_version) !== oldCrypto.getCallbackTokenVersion()) {
                        throw new Error(`记录 ${row.id} 的回调Token版本无效，请先完成数据库迁移`);
                    }
                    const callbackToken = oldCrypto.decryptCallbackToken(
                        row.encrypted_callback_token,
                        row.callback_token_version
                    );
                    if (row.callback_token_hash !== oldCrypto.hashCallbackToken(callbackToken)) {
                        throw new Error(`记录 ${row.id} 的回调Token摘要不匹配，请先完成数据库迁移`);
                    }
                    const encryptedCallbackToken = newCrypto.encryptCallbackToken(callbackToken);
                    if (newCrypto.decryptCallbackToken(
                        encryptedCallbackToken,
                        newCrypto.getCallbackTokenVersion()
                    ) !== callbackToken) {
                        throw new Error(`记录 ${row.id} 的 encrypted_callback_token 重加密校验失败`);
                    }
                    updates.encrypted_callback_token = encryptedCallbackToken;
                    updates.callback_token_hash = newCrypto.hashCallbackToken(callbackToken);
                    updates.callback_token_version = newCrypto.getCallbackTokenVersion();
                    rotatedFields += 1;
                } else if (row.callback_token_hash !== null || row.callback_token_version !== null) {
                    throw new Error(`记录 ${row.id} 的回调Token迁移状态不完整，请先完成数据库迁移`);
                }
            }

            if (Object.keys(updates).length > 0) {
                const values = [
                    Object.prototype.hasOwnProperty.call(updates, 'encrypted_corpsecret')
                        ? updates.encrypted_corpsecret
                        : row.encrypted_corpsecret,
                    Object.prototype.hasOwnProperty.call(updates, 'encrypted_encoding_aes_key')
                        ? updates.encrypted_encoding_aes_key
                        : row.encrypted_encoding_aes_key
                ];
                let updateSql = `UPDATE configurations
                                 SET encrypted_corpsecret = ?, encrypted_encoding_aes_key = ?`;
                if (hasCallbackTokenColumns) {
                    updateSql += `, encrypted_callback_token = ?, callback_token_hash = ?,
                                  callback_token_version = ?`;
                    values.push(
                        Object.prototype.hasOwnProperty.call(updates, 'encrypted_callback_token')
                            ? updates.encrypted_callback_token
                            : row.encrypted_callback_token,
                        Object.prototype.hasOwnProperty.call(updates, 'callback_token_hash')
                            ? updates.callback_token_hash
                            : row.callback_token_hash,
                        Object.prototype.hasOwnProperty.call(updates, 'callback_token_version')
                            ? updates.callback_token_version
                            : row.callback_token_version
                    );
                }
                updateSql += ' WHERE id = ?';
                values.push(row.id);
                await run(db, updateSql, values);
            }
        }

        await run(db, 'COMMIT');
        transactionStarted = false;
        rotationCommitted = true;
        console.log(`密钥轮换完成，共重加密 ${rotatedFields} 个字段。`);
        console.log('请使用NEW_ENCRYPTION_KEY作为新的ENCRYPTION_KEY启动服务，并在验证后安全保管或清理旧密钥与备份。');
    } catch (error) {
        if (db && transactionStarted) {
            try {
                await run(db, 'ROLLBACK');
                console.error('轮换失败，事务已回滚；数据库备份保持不变。');
            } catch (rollbackError) {
                console.error('轮换失败且自动回滚失败，请保持服务停止并从备份恢复。');
            }
        }
        throw error;
    } finally {
        if (db) {
            try {
                await closeDatabase(db);
            } catch (closeError) {
                if (!rotationCommitted) {
                    throw closeError;
                }
                console.error('密钥轮换已提交，但关闭数据库连接失败；请使用新密钥启动并检查数据库状态。');
            }
        }
    }
}

rotate().catch((error) => {
    console.error(`密钥轮换失败: ${error.message}`);
    process.exitCode = 1;
});
