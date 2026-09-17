const net = require('net');

function readBooleanSetting(name, defaultValue = false) {
    const value = process.env[name];
    if (value === undefined || value === '') {
        return defaultValue;
    }
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    throw new Error(`${name}必须是true或false`);
}

function readRequireHttps() {
    const isProduction = process.env.NODE_ENV === 'production';
    const requireHttps = readBooleanSetting('REQUIRE_HTTPS', isProduction);
    if (isProduction && !requireHttps) {
        throw new Error('生产环境必须设置REQUIRE_HTTPS=true');
    }
    return requireHttps;
}

function readPublicOrigin(requireHttps) {
    const value = process.env.PUBLIC_ORIGIN;
    if (!requireHttps) {
        return value || null;
    }
    if (!value) {
        throw new Error('启用HTTPS边界时必须设置PUBLIC_ORIGIN');
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw new Error('PUBLIC_ORIGIN必须是有效的HTTPS源地址');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error('PUBLIC_ORIGIN必须是仅包含协议、主机和可选端口的HTTPS源地址');
    }
    return parsed.origin;
}

function isValidProxyToken(value) {
    if (['loopback', 'linklocal', 'uniquelocal'].includes(value)) {
        return true;
    }

    const parts = value.split('/');
    if (parts.length > 2 || net.isIP(parts[0]) === 0) {
        return false;
    }
    if (parts.length === 1) {
        return true;
    }

    const prefix = Number(parts[1]);
    const maxPrefix = net.isIP(parts[0]) === 4 ? 32 : 128;
    return Number.isInteger(prefix) && prefix >= 0 && prefix <= maxPrefix;
}

function readTrustedProxies() {
    const value = process.env.TRUSTED_PROXY_CIDRS || 'loopback';
    const proxies = value.split(',').map((item) => item.trim()).filter(Boolean);
    if (proxies.length === 0 || !proxies.every(isValidProxyToken)) {
        throw new Error('TRUSTED_PROXY_CIDRS必须是受限的IP、CIDR或loopback/linklocal/uniquelocal列表');
    }
    return proxies;
}

function createHttpsBoundary(options = {}) {
    const requireHttps = options.requireHttps ?? readRequireHttps();
    const enableHsts = options.enableHsts ?? readBooleanSetting('ENABLE_HSTS', false);
    const publicOrigin = options.publicOrigin ?? readPublicOrigin(requireHttps);

    return function httpsBoundary(req, res, next) {
        if (req.secure && enableHsts) {
            res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }

        if (!requireHttps || req.secure) {
            return next();
        }

        if (req.method === 'GET' || req.method === 'HEAD') {
            const requestPath = req.originalUrl.startsWith('/') ? req.originalUrl : `/${req.originalUrl}`;
            return res.redirect(308, `${publicOrigin}${requestPath}`);
        }

        return res.status(426).json({ error: '该请求必须通过HTTPS发送，明文请求不会被处理' });
    };
}

module.exports = {
    createHttpsBoundary,
    readBooleanSetting,
    readRequireHttps,
    readPublicOrigin,
    readTrustedProxies
};
