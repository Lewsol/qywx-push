const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createSafeErrorHandler } = require('../src/core/safe-error-handler');
const { createSecurityLogger } = require('../src/core/security-logger');

const projectRoot = path.join(__dirname, '..');

function readProjectFile(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('security logger only emits sanitized allowlisted fields', () => {
    const completeCode = '8cd876d8-4b0b-4d25-9ae2-5cb45703e9b1';
    const notifyToken = 'notify_YG9ub3Rsb2d0aGlzX3Rva2VuXzEyMzQ1Njc4OTA';
    const corpSecret = 'corpsecret_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const encodingKey = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const callbackToken = 'callback-token-DO-NOT-LOG-1234567890';
    const accessToken = 'access-token-DO-NOT-LOG-0987654321';
    const adminToken = 'ADMIN_TOKEN_DO_NOT_LOG_abcdefghijklmnopqrstuvwxyz';
    const messageBody = 'UNIQUE CALLBACK BODY\nFOR LOG INJECTION';
    const captured = [];
    const log = createSecurityLogger((line) => captured.push(line));

    log({
        requestId: '9e7fc4ad-128e-4b2c-9522-a4e041ce28b3',
        configRef: completeCode,
        messageType: 'text',
        status: 'failed',
        durationMs: 17.6,
        errorCategory: 'invalid_request',
        notifyToken,
        corpSecret,
        encodingKey,
        callbackToken,
        accessToken,
        adminToken,
        requestBody: messageBody,
        error: new Error(`${messageBody}: ${corpSecret}`)
    });

    log({
        requestId: adminToken,
        configRef: completeCode,
        messageType: messageBody,
        status: accessToken,
        durationMs: Number.POSITIVE_INFINITY,
        errorCategory: corpSecret,
        [callbackToken]: encodingKey
    });

    const output = captured.join('\n');
    for (const sensitiveValue of [
        completeCode,
        notifyToken,
        corpSecret,
        encodingKey,
        callbackToken,
        accessToken,
        adminToken,
        messageBody
    ]) {
        assert.equal(output.includes(sensitiveValue), false, `log leaked: ${sensitiveValue}`);
    }

    const allowedFields = new Set([
        'requestId',
        'configRef',
        'messageType',
        'status',
        'durationMs',
        'errorCategory'
    ]);
    for (const line of captured) {
        const parsed = JSON.parse(line);
        assert.ok(Object.keys(parsed).every((field) => allowedFields.has(field)));
    }

    const first = JSON.parse(captured[0]);
    assert.match(first.configRef, /^[0-9a-f]{12}$/);
    assert.equal(first.messageType, 'text');
    assert.equal(first.durationMs, 18);

    const second = JSON.parse(captured[1]);
    assert.equal(second.requestId, undefined);
    assert.equal(second.messageType, 'unknown');
    assert.equal(second.status, 'failed');
    assert.equal(second.errorCategory, 'internal_error');
    assert.equal(second.durationMs, undefined);
});

test('callback sources do not log or return message bodies and sender identifiers', () => {
    const callbackSource = [
        readProjectFile('src/api/routes.js'),
        readProjectFile('src/services/notifier.js'),
        readProjectFile('src/core/wechat-callback.js')
    ].join('\n');

    assert.equal(callbackSource.includes('result.message'), false);
    assert.equal(callbackSource.includes('fromUserName'), false);
    assert.doesNotMatch(callbackSource, /回调消息[^\n]*(?:正文|内容|发送者)/);
});

test('request IDs are generated before the HTTPS boundary without trusting client input', () => {
    const serverSource = readProjectFile('server.js');
    const requestIdPosition = serverSource.indexOf('req.requestId = crypto.randomUUID()');
    const httpsBoundaryPosition = serverSource.indexOf('app.use(createHttpsBoundary())');

    assert.ok(requestIdPosition >= 0);
    assert.ok(httpsBoundaryPosition > requestIdPosition);
    assert.match(serverSource, /res\.set\('X-Request-ID', req\.requestId\)/);
    assert.doesNotMatch(serverSource, /req\.(?:get|header)\(['"]x-request-id/i);
});

test('malformed bodies use the safe error handler without logging URL tokens or body fragments', async () => {
    const notifyToken = 'notify-token-DO-NOT-LOG-1234567890';
    const bodySecret = 'body-secret\n\u001b[31mLOG-INJECTION';
    const captured = [];
    const logger = createSecurityLogger((line) => captured.push(line));
    const app = express();
    app.use((req, res, next) => {
        req.requestId = crypto.randomUUID();
        req.startedAt = Date.now();
        next();
    });
    app.use(express.json());
    app.post('/api/notify/:token', (req, res) => res.json({ ok: true }));
    app.use(createSafeErrorHandler(logger));
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/api/notify/${notifyToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: `{"content":"${bodySecret}`
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: '请求体格式无效' });
        const output = captured.join('\n');
        assert.equal(output.includes(notifyToken), false);
        assert.equal(output.includes(bodySecret), false);
        assert.equal(output.includes('LOG-INJECTION'), false);
        assert.equal(output.includes('\u001b'), false);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('Nginx access log format excludes request URLs, query strings and bearer path credentials', () => {
    const nginxSource = readProjectFile('deploy/nginx/wechat-notifier.conf.example');
    const format = nginxSource.match(/log_format qywx_safe([\s\S]*?);/);
    assert.ok(format, 'safe Nginx log format is missing');
    assert.doesNotMatch(format[1], /\$request(?!_id|_method|_time)/);
    assert.doesNotMatch(format[1], /\$(?:request_uri|uri|args)/);
    assert.match(nginxSource, /error_log\s+[^;]+\s+crit;/);
});
