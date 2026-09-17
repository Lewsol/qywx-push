const crypto = require('crypto');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{32,}$/;

if (!ADMIN_TOKEN || !BASE64URL_TOKEN.test(ADMIN_TOKEN)) {
    throw new Error('ADMIN_TOKEN必须是至少32字符的base64url安全随机值');
}

const expectedDigest = crypto.createHash('sha256').update(ADMIN_TOKEN, 'utf8').digest();

function isValidAdminToken(authorization) {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
        return false;
    }

    const suppliedToken = authorization.slice('Bearer '.length);
    const suppliedDigest = crypto.createHash('sha256').update(suppliedToken, 'utf8').digest();
    return crypto.timingSafeEqual(expectedDigest, suppliedDigest);
}

function requireAdmin(req, res, next) {
    if (!isValidAdminToken(req.get('authorization'))) {
        return res.status(401).json({ error: '管理员认证失败' });
    }
    next();
}

module.exports = {
    requireAdmin,
    isValidAdminToken
};
