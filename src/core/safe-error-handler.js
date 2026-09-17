const { logSecurityEvent } = require('./security-logger');

function createSafeErrorHandler(logger = logSecurityEvent) {
    return function safeErrorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
        const isTooLarge = error && (error.type === 'entity.too.large' || error.status === 413);
        const isParseFailure = error && (
            error.type === 'entity.parse.failed'
            || (error instanceof SyntaxError && error.status === 400)
        );
        const statusCode = isTooLarge ? 413 : (isParseFailure ? 400 : 500);

        logger({
            requestId: req.requestId,
            status: 'failed',
            durationMs: req.startedAt ? Date.now() - req.startedAt : undefined,
            errorCategory: statusCode === 500 ? 'internal_error' : 'invalid_request'
        });

        if (res.headersSent) {
            return res.end();
        }
        if (statusCode === 413) {
            return res.status(413).json({ error: '请求体过大' });
        }
        if (statusCode === 400) {
            return res.status(400).json({ error: '请求体格式无效' });
        }
        return res.status(500).json({ error: '服务器内部错误' });
    };
}

module.exports = {
    createSafeErrorHandler
};
