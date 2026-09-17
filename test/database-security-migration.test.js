const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const CryptoService = require('../src/core/crypto');
const Database = require('../src/core/database');

function createLegacyDatabase(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename);
        db.serialize(() => {
            db.run(`
                CREATE TABLE configurations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT UNIQUE NOT NULL,
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
            `);
            db.run(
                `INSERT INTO configurations
                 (code, corpid, encrypted_corpsecret, agentid, touser, description, callback_enabled)
                 VALUES (?, ?, ?, ?, ?, ?, 0)`,
                ['historically-logged-code', 'corp', 'legacy-ciphertext', 1, 'user', 'legacy']
            );
        });
        db.close((error) => error ? reject(error) : resolve());
    });
}

test('legacy codes remain stable callback identifiers but are rotated out of notification credentials', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qywx-notify-token-migration-'));
    const filename = path.join(directory, 'legacy.db');
    const crypto = new CryptoService('0123456789abcdef0123456789abcdef');

    try {
        await createLegacyDatabase(filename);
        const first = new Database(filename, crypto);
        await first.init();
        const migrated = await first.getConfigurationByCode('historically-logged-code');
        assert.equal(migrated.code, 'historically-logged-code');
        assert.match(migrated.notify_token, /^[A-Za-z0-9_-]{43}$/);
        assert.notEqual(migrated.notify_token, migrated.code);
        assert.equal(await first.getConfigurationByNotifyToken(migrated.code), undefined);
        assert.equal((await first.getConfigurationByNotifyToken(migrated.notify_token)).code, migrated.code);
        const marker = await first.get(
            "SELECT status FROM security_migrations WHERE name = 'notify_token_separation_v2'"
        );
        assert.equal(marker.status, 'complete');
        const firstToken = migrated.notify_token;
        await first.close();

        const second = new Database(filename, crypto);
        await second.init();
        const afterRestart = await second.getConfigurationByCode('historically-logged-code');
        assert.equal(afterRestart.notify_token, firstToken, 'security migration must only rotate once');
        await second.close();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
