const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { JSDOM } = require('jsdom');
const { securityHeaders } = require('../src/core/security-headers');

const projectRoot = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8');
const docsHtml = fs.readFileSync(path.join(projectRoot, 'public', 'api-docs.html'), 'utf8');
const frontendScript = fs.readFileSync(path.join(projectRoot, 'public', 'script.js'), 'utf8');
const builtCss = fs.readFileSync(path.join(projectRoot, 'public', 'styles.css'), 'utf8');
const serverSource = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');

function response(data, ok = true) {
    return {
        ok,
        async json() {
            return data;
        }
    };
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.fail(message);
}

function submit(window, form) {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('pages only reference self-hosted runtime resources and have no inline code or styles', () => {
    const pageUrl = new URL('https://notify.example.test/');
    for (const html of [indexHtml, docsHtml]) {
        const dom = new JSDOM(html, { url: pageUrl });
        const { document } = dom.window;
        assert.equal(document.querySelectorAll('style, [style]').length, 0);
        for (const script of document.querySelectorAll('script')) {
            const source = script.getAttribute('src');
            assert.ok(source, 'script elements must use an external same-origin file');
            assert.ok(source.startsWith('/') && !source.startsWith('//'), 'protocol-relative scripts are forbidden');
            assert.equal(new URL(source, pageUrl).origin, pageUrl.origin);
            assert.equal(script.textContent.trim(), '');
        }
        for (const stylesheet of document.querySelectorAll('link[rel="stylesheet"]')) {
            const href = stylesheet.getAttribute('href');
            assert.ok(href.startsWith('/') && !href.startsWith('//'), 'protocol-relative stylesheets are forbidden');
            assert.equal(new URL(href, pageUrl).origin, pageUrl.origin);
        }
        dom.window.close();
    }

    assert.doesNotMatch(frontendScript, /\b(?:innerHTML|insertAdjacentHTML|outerHTML|document\.write)\b/);
    assert.doesNotMatch(builtCss, /sourceMappingURL|@import\s/i);
    for (const match of builtCss.matchAll(/url\(([^)]+)\)/gi)) {
        const value = match[1].trim().replace(/^['"]|['"]$/g, '');
        assert.ok(value.startsWith('data:'), `external CSS URL is forbidden: ${value}`);
    }
});

test('sensitive forms remain disabled and use POST when JavaScript does not initialize', () => {
    const dom = new JSDOM(indexHtml, { url: 'https://notify.example.test/' });
    const { document, FormData } = dom.window;
    for (const form of document.querySelectorAll('form')) {
        assert.equal(form.method.toLowerCase(), 'post');
        assert.equal(new URL(form.action).origin, 'https://notify.example.test');
        const fieldset = form.querySelector('fieldset[data-requires-js]');
        assert.ok(fieldset && fieldset.disabled, `${form.id} must be disabled before script initialization`);
        assert.deepEqual(Array.from(new FormData(form).entries()), []);
    }
    dom.window.close();
});

test('committed CSS matches a clean local rebuild', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qywx-css-build-'));
    const output = path.join(directory, 'styles.css');
    try {
        execFileSync(process.execPath, [
            require.resolve('tailwindcss/lib/cli.js'),
            '-c', 'tailwind.config.js',
            '-i', './src/styles.css',
            '-o', output,
            '--minify'
        ], { cwd: projectRoot, stdio: 'pipe' });
        assert.deepEqual(fs.readFileSync(output), Buffer.from(builtCss));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('actual HTTP response carries strict CSP without inline or eval exceptions', async () => {
    assert.match(serverSource, /app\.use\(securityHeaders\)/);
    const app = express();
    app.use(securityHeaders);
    app.get('/', (req, res) => res.send('ok'));
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}/`);
        const csp = response.headers.get('content-security-policy');
        assert.equal(response.status, 200);
        for (const directive of [
            "default-src 'self'", "script-src 'self'", "style-src 'self'",
            "connect-src 'self'", "img-src 'self' data:", "object-src 'none'",
            "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"
        ]) {
            assert.ok(csp.includes(directive), `missing CSP directive: ${directive}`);
        }
        assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('member, configuration and error payloads are rendered only as text', async () => {
    const dom = new JSDOM(indexHtml, {
        url: 'https://notify.example.test/',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const { document } = window;
    const pendingResponses = [];
    const requests = [];

    window.Headers = global.Headers;
    Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => undefined }
    });
    window.fetch = async (url, options) => {
        requests.push({ url, options });
        assert.ok(pendingResponses.length > 0, `unexpected request: ${url}`);
        return pendingResponses.shift();
    };

    window.eval(frontendScript);
    if (document.readyState === 'loading') {
        await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }

    const adminForm = document.getElementById('adminTokenForm');
    document.getElementById('adminTokenInput').value = 'A'.repeat(32);
    submit(window, adminForm);

    const callbackForm = document.getElementById('callbackForm');
    callbackForm.elements.namedItem('corpid').value = 'corp-id';
    callbackForm.elements.namedItem('callback_token').value = 'callback-token';
    callbackForm.elements.namedItem('encoding_aes_key').value = 'B'.repeat(43);
    pendingResponses.push(response({
        code: 'stable-code',
        callbackUrl: '/api/callback/stable-code'
    }));
    submit(window, callbackForm);
    await waitFor(() => requests.length === 1, 'callback request was not sent');
    await waitFor(() => document.getElementById('step2-container').classList.contains('hidden') === false, 'step two was not shown');

    const imagePayload = '<img src=x onerror=globalThis.imageExecuted=true>';
    const quotePayload = 'user-id" onclick="globalThis.quoteExecuted=true';
    const svgPayload = '<svg onload=globalThis.svgExecuted=true></svg>';
    const configForm = document.getElementById('configForm');
    configForm.elements.namedItem('corpsecret').value = 'secret';
    pendingResponses.push(response({
        users: [{ name: `${imagePayload}${svgPayload}`, userid: quotePayload }]
    }));
    document.getElementById('validateBtn').click();
    await waitFor(() => requests.length === 2, 'validation request was not sent');
    const userList = document.getElementById('userList');
    await waitFor(() => userList.textContent.includes(imagePayload), 'member payload was not rendered');
    assert.ok(userList.textContent.includes(svgPayload));
    assert.ok(userList.textContent.includes(quotePayload));
    assert.equal(userList.querySelector('img, svg'), null);
    assert.equal(userList.querySelector('input').value, quotePayload);

    const descriptionPayload = `description ${imagePayload} "quoted" ${svgPayload}`;
    const lookupForm = document.getElementById('lookupForm');
    lookupForm.elements.namedItem('code').value = 'stable/code?value';
    pendingResponses.push(response({
        code: 'stable/code?value',
        corpid: imagePayload,
        agentid: '100001',
        touser: [quotePayload],
        description: descriptionPayload,
        callback_enabled: true,
        callback_token_configured: true,
        created_at: '2025-01-01T00:00:00.000Z',
        apiUrl: `/api/notify/${quotePayload}`
    }));
    submit(window, lookupForm);
    await waitFor(() => requests.length === 3, 'lookup request was not sent');
    const lookupResult = document.getElementById('lookup-result');
    await waitFor(() => lookupResult.textContent.includes(descriptionPayload), 'description payload was not rendered');
    assert.equal(lookupResult.querySelector('img, svg'), null);
    assert.equal(requests[2].url, '/api/configuration/stable%2Fcode%3Fvalue');

    const errorPayload = `failed ${imagePayload} ${svgPayload} "quoted"`;
    pendingResponses.push(response({ error: errorPayload }, false));
    submit(window, lookupForm);
    await waitFor(() => requests.length === 4, 'failed lookup request was not sent');
    await waitFor(() => lookupResult.textContent.includes(errorPayload), 'error payload was not rendered');
    assert.equal(lookupResult.querySelector('img, svg'), null);
    assert.equal(window.imageExecuted, undefined);
    assert.equal(window.quoteExecuted, undefined);
    assert.equal(window.svgExecuted, undefined);

    window.close();
});
