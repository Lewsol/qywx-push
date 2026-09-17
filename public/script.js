// 企业微信通知配置前端交互脚本

document.addEventListener('DOMContentLoaded', function () {
    const adminTokenForm = document.getElementById('adminTokenForm');
    const adminTokenInput = document.getElementById('adminTokenInput');
    const adminTokenStatus = document.getElementById('adminTokenStatus');
    const callbackForm = document.getElementById('callbackForm');
    const configForm = document.getElementById('configForm');
    const validateBtn = document.getElementById('validateBtn');
    const userListSection = document.getElementById('userListSection');
    const userList = document.getElementById('userList');
    const lookupForm = document.getElementById('lookupForm');
    const lookupResultDiv = document.getElementById('lookup-result');
    const resultDiv = document.getElementById('result');
    const saveAlert = document.getElementById('save-alert');
    const step2Container = document.getElementById('step2-container');
    const callbackResult = document.getElementById('callbackResult');

    let currentCode = null;
    let adminToken = '';

    function asText(value, fallback = '') {
        if (value === undefined || value === null) {
            return fallback;
        }
        return String(value);
    }

    function createNode(tagName, className, text) {
        const node = document.createElement(tagName);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = asText(text);
        }
        return node;
    }

    function createCard(title, titleClass = '') {
        const card = createNode('div', 'card bg-base-100 shadow-md');
        const body = createNode('div', 'card-body');
        const heading = createNode('h2', `card-title ${titleClass}`.trim(), title);
        body.appendChild(heading);
        card.appendChild(body);
        return { card, body };
    }

    function appendValue(parent, label, value, monospace = false) {
        const wrapper = createNode('div', 'space-y-1');
        wrapper.appendChild(createNode('div', 'font-medium', label));
        wrapper.appendChild(createNode(
            'div',
            `${monospace ? 'font-mono ' : ''}overflow-x-auto rounded-md bg-base-200 p-2 text-sm`,
            value
        ));
        parent.appendChild(wrapper);
    }

    function appendDetail(parent, label, value) {
        const row = createNode('p');
        row.appendChild(createNode('span', 'font-medium', `${label}: `));
        row.appendChild(document.createTextNode(asText(value)));
        parent.appendChild(row);
    }

    function createAlert(kind, message) {
        const alert = createNode('div', `alert ${kind}`);
        alert.appendChild(createNode('span', '', message));
        return alert;
    }

    function getFormValue(form, name) {
        const field = form.elements.namedItem(name);
        return field ? field.value.trim() : '';
    }

    function getErrorMessage(data, fallback) {
        return data && typeof data.error === 'string' && data.error ? data.error : fallback;
    }

    async function readJson(response) {
        try {
            return await response.json();
        } catch (error) {
            return {};
        }
    }

    function toAbsoluteUrl(value) {
        const url = asText(value);
        try {
            return new URL(url, window.location.origin).toString();
        } catch (error) {
            return url;
        }
    }

    function formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? asText(value, '未知') : date.toLocaleString();
    }

    function showError(message) {
        resultDiv.replaceChildren(createAlert('alert-error', message));
    }

    function showLookupError(message) {
        lookupResultDiv.replaceChildren(createAlert('alert-error', message));
    }

    function showToast(message) {
        const toast = createNode('div', 'toast toast-top toast-center');
        toast.setAttribute('role', 'status');
        toast.appendChild(createAlert('alert-info', message));
        document.body.appendChild(toast);
        window.setTimeout(() => toast.remove(), 3000);
    }

    async function copyText(value, successMessage) {
        try {
            await navigator.clipboard.writeText(asText(value));
            showToast(successMessage);
        } catch (error) {
            showError('复制失败，请手动选择并复制内容');
        }
    }

    function createCopyButton(label, value, successMessage) {
        const button = createNode('button', 'btn btn-outline btn-sm', label);
        button.type = 'button';
        button.addEventListener('click', () => copyText(value, successMessage));
        return button;
    }

    async function adminFetch(url, options = {}) {
        if (!adminToken) {
            throw new Error('请先输入并应用管理员 Token');
        }
        const headers = new Headers(options.headers || {});
        headers.set('Authorization', `Bearer ${adminToken}`);
        return fetch(url, { ...options, headers });
    }

    adminTokenForm.addEventListener('submit', function (event) {
        event.preventDefault();
        const value = adminTokenInput.value;
        if (!/^[A-Za-z0-9_-]{32,}$/.test(value)) {
            showError('管理员 Token 必须是至少 32 字符的 base64url 安全随机值');
            return;
        }
        adminToken = value;
        adminTokenInput.value = '';
        adminTokenStatus.textContent = '管理员 Token 已载入当前页面内存；刷新后需要重新输入';
        resultDiv.replaceChildren();
        showToast('管理员 Token 已应用');
    });

    callbackForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        resultDiv.replaceChildren();

        const corpid = getFormValue(callbackForm, 'corpid');
        const callbackToken = getFormValue(callbackForm, 'callback_token');
        const encodingAesKey = getFormValue(callbackForm, 'encoding_aes_key');
        if (!corpid || !callbackToken || !encodingAesKey) {
            showError('请填写所有必填项');
            return;
        }
        if (encodingAesKey.length !== 43) {
            showError('EncodingAESKey 必须是 43 位字符');
            return;
        }

        const submitBtn = callbackForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = '生成中...';

        try {
            const response = await adminFetch('/api/generate-callback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    corpid,
                    callback_token: callbackToken,
                    encoding_aes_key: encodingAesKey
                })
            });
            const data = await readJson(response);
            if (!response.ok) {
                throw new Error(getErrorMessage(data, '生成失败'));
            }
            currentCode = asText(data.code);
            showCallbackResult(data);
            step2Container.classList.remove('hidden');
        } catch (error) {
            showError(`生成回调 URL 失败: ${error.message}`);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = '生成回调 URL';
        }
    });

    validateBtn.addEventListener('click', async function () {
        resultDiv.replaceChildren();
        userList.replaceChildren();
        userListSection.classList.add('hidden');

        const corpid = getFormValue(callbackForm, 'corpid');
        const corpsecret = getFormValue(configForm, 'corpsecret');
        if (!corpid || !corpsecret) {
            showError('请填写 CorpSecret');
            return;
        }

        validateBtn.disabled = true;
        validateBtn.textContent = '验证中...';
        try {
            const response = await adminFetch('/api/validate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ corpid, corpsecret })
            });
            const data = await readJson(response);
            if (!response.ok) {
                throw new Error(getErrorMessage(data, '验证失败'));
            }
            const users = Array.isArray(data.users) ? data.users : [];
            if (users.length === 0) {
                showError('未获取到任何成员');
                return;
            }

            const fragment = document.createDocumentFragment();
            users.forEach((user) => {
                const label = createNode('label', 'flex cursor-pointer items-center gap-2');
                const checkbox = createNode('input', 'checkbox checkbox-sm');
                checkbox.type = 'checkbox';
                checkbox.value = asText(user && user.userid);
                const member = createNode('span');
                member.appendChild(document.createTextNode(asText(user && user.name, '未命名成员')));
                member.appendChild(createNode('span', 'ml-1 text-xs text-gray-500', `(${asText(user && user.userid)})`));
                label.append(checkbox, member);
                fragment.appendChild(label);
            });
            userList.replaceChildren(fragment);
            userListSection.classList.remove('hidden');
        } catch (error) {
            showError(error.message);
        } finally {
            validateBtn.disabled = false;
            validateBtn.textContent = '验证并获取成员列表';
        }
    });

    configForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        resultDiv.replaceChildren();

        if (!currentCode) {
            showError('请先完成第一步生成回调 URL');
            return;
        }

        const corpsecret = getFormValue(configForm, 'corpsecret');
        const agentid = getFormValue(configForm, 'agentid');
        const description = getFormValue(configForm, 'description');
        const selectedUsers = Array.from(userList.querySelectorAll('input[type="checkbox"]:checked'))
            .map((checkbox) => checkbox.value);
        if (!corpsecret || !agentid || selectedUsers.length === 0) {
            showError('请填写所有必填项并选择至少一个成员');
            return;
        }

        const submitBtn = configForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = '完成中...';
        try {
            const response = await adminFetch('/api/complete-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: currentCode,
                    corpsecret,
                    agentid: Number(agentid),
                    touser: selectedUsers,
                    description
                })
            });
            const data = await readJson(response);
            if (!response.ok) {
                throw new Error(getErrorMessage(data, '完成失败'));
            }
            showFinalResult(data);
            saveAlert.classList.remove('hidden');
            window.setTimeout(() => saveAlert.classList.add('hidden'), 5000);
        } catch (error) {
            showError(error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = '完成配置';
        }
    });

    lookupForm.addEventListener('submit', async function (event) {
        event.preventDefault();
        const code = getFormValue(lookupForm, 'code');
        if (!code) {
            return;
        }

        const loading = createNode('span', 'loading loading-spinner loading-md');
        const loadingWrapper = createNode('div', 'flex justify-center p-4');
        loadingWrapper.appendChild(loading);
        lookupResultDiv.replaceChildren(loadingWrapper);

        try {
            const response = await adminFetch(`/api/configuration/${encodeURIComponent(code)}`);
            const data = await readJson(response);
            if (!response.ok) {
                throw new Error(getErrorMessage(data, '查找配置失败'));
            }
            showConfiguration(data, code);
        } catch (error) {
            showLookupError(error.message);
        }
    });

    function showCallbackResult(data) {
        const { card, body } = createCard('回调 URL 生成成功', 'text-primary');
        const details = createNode('div', 'mt-4 space-y-4');
        const callbackUrl = toAbsoluteUrl(data.callbackUrl);
        appendValue(details, '您的配置 Code', data.code, true);
        appendValue(details, '回调 URL', callbackUrl, true);
        details.appendChild(createCopyButton('复制回调 URL', callbackUrl, '回调 URL 已复制到剪贴板'));
        body.appendChild(details);
        body.appendChild(createAlert('alert-info mt-4', '下一步：将回调 URL 配置到企业微信后台，配置服务器 IP 白名单，然后完成第二步。'));
        callbackResult.replaceChildren(card);
        callbackResult.classList.remove('hidden');
    }

    function showFinalResult(data) {
        const { card, body } = createCard('配置完成', 'text-success');
        const details = createNode('div', 'mt-4 space-y-4');
        const apiUrl = toAbsoluteUrl(data.apiUrl);
        const callbackUrl = toAbsoluteUrl(data.callbackUrl);
        appendValue(details, '配置 Code', data.code, true);
        appendValue(details, '通知 API 地址', apiUrl, true);
        details.appendChild(createCopyButton('复制通知 API 地址', apiUrl, 'API 地址已复制到剪贴板'));
        appendValue(details, '回调地址', callbackUrl, true);
        details.appendChild(createCopyButton('复制回调地址', callbackUrl, '回调地址已复制到剪贴板'));
        body.appendChild(details);
        body.appendChild(createAlert('alert-success mt-4', '配置已完成。请妥善保存配置 Code 和通知地址。'));
        resultDiv.replaceChildren(card);
    }

    function showConfiguration(data, requestedCode) {
        const { card, body } = createCard('配置详情');
        const details = createNode('div', 'mt-2 space-y-2');
        const users = Array.isArray(data.touser) ? data.touser.map((item) => asText(item)).join(', ') : asText(data.touser);
        appendDetail(details, 'CorpID', data.corpid);
        appendDetail(details, 'AgentID', data.agentid);
        appendDetail(details, '接收用户', users || '无');
        appendDetail(details, '描述', asText(data.description, '无') || '无');
        appendDetail(details, '回调状态', data.callback_enabled ? '已启用' : '未启用');
        if (data.callback_enabled) {
            appendDetail(details, '回调 Token', data.callback_token_configured ? '已配置' : '未配置');
        }
        appendDetail(details, '创建时间', formatDate(data.created_at));
        body.appendChild(details);

        const apiUrl = toAbsoluteUrl(data.apiUrl);
        const apiSection = createNode('div', 'mt-4 space-y-2');
        appendValue(apiSection, '通知 API 地址', apiUrl, true);
        body.appendChild(apiSection);

        const actions = createNode('div', 'card-actions mt-4 justify-end');
        actions.appendChild(createCopyButton('复制 API 地址', apiUrl, 'API 地址已复制到剪贴板'));
        const rotateButton = createNode('button', 'btn btn-warning btn-sm', '轮换通知 Token');
        rotateButton.type = 'button';
        rotateButton.addEventListener('click', async function () {
            rotateButton.disabled = true;
            try {
                const configurationCode = asText(data.code, requestedCode) || requestedCode;
                const response = await adminFetch(
                    `/api/configuration/${encodeURIComponent(configurationCode)}/rotate-notify-token`,
                    { method: 'POST' }
                );
                const rotateData = await readJson(response);
                if (!response.ok) {
                    throw new Error(getErrorMessage(rotateData, '轮换失败'));
                }
                const newApiUrl = toAbsoluteUrl(rotateData.apiUrl);
                showToast('通知 Token 已轮换，旧通知地址立即失效');
                showRotatedToken(newApiUrl);
            } catch (error) {
                showError(error.message);
            } finally {
                rotateButton.disabled = false;
            }
        });
        actions.appendChild(rotateButton);
        body.appendChild(actions);
        lookupResultDiv.replaceChildren(card);
    }

    function showRotatedToken(apiUrl) {
        const { card, body } = createCard('通知 Token 轮换成功', 'text-success');
        appendValue(body, '新的通知 API 地址', apiUrl, true);
        body.appendChild(createCopyButton('复制新的 API 地址', apiUrl, '新的 API 地址已复制到剪贴板'));
        body.appendChild(createAlert('alert-warning mt-4', '旧通知地址已失效，请立即更新所有调用方并安全保存新地址。'));
        resultDiv.replaceChildren(card);
    }

    // 只有脚本完整初始化并绑定全部处理器后才启用表单，避免脚本失败时浏览器默认提交敏感字段。
    document.querySelectorAll('fieldset[data-requires-js]').forEach((fieldset) => {
        fieldset.disabled = false;
    });
});
