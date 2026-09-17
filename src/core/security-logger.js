const { summarizeIdentifier } = require('./identifier');

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_TYPE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const ALLOWED_STATUSES = new Set(['success', 'failed', 'rejected']);
const ALLOWED_ERROR_CATEGORIES = new Set([
    'authentication_failed',
    'callback_configuration_incomplete',
    'callback_disabled',
    'callback_verification_failed',
    'database_connection_failed',
    'database_initialization_failed',
    'database_migration_failed',
    'database_operation_failed',
    'decryption_failed',
    'encryption_failed',
    'external_api_failed',
    'https_required',
    'internal_error',
    'invalid_request',
    'message_decryption_failed',
    'message_parse_failed'
]);

function buildSecurityRecord(fields = {}) {
    const record = {};

    if (typeof fields.requestId === 'string' && REQUEST_ID_PATTERN.test(fields.requestId)) {
        record.requestId = fields.requestId;
    }
    if (typeof fields.configRef === 'string' && fields.configRef.length > 0) {
        record.configRef = summarizeIdentifier(fields.configRef);
    }
    if (typeof fields.messageType === 'string') {
        record.messageType = MESSAGE_TYPE_PATTERN.test(fields.messageType) ? fields.messageType : 'unknown';
    }
    if (typeof fields.status === 'string') {
        record.status = ALLOWED_STATUSES.has(fields.status) ? fields.status : 'failed';
    }
    if (Number.isFinite(fields.durationMs)) {
        record.durationMs = Math.max(0, Math.min(Math.round(fields.durationMs), 86400000));
    }
    if (fields.errorCategory !== undefined) {
        record.errorCategory = ALLOWED_ERROR_CATEGORIES.has(fields.errorCategory)
            ? fields.errorCategory
            : 'internal_error';
    }

    return record;
}

function createSecurityLogger(sink = console.log) {
    if (typeof sink !== 'function') {
        throw new TypeError('security log sink must be a function');
    }

    return function logSecurityEvent(fields) {
        const record = buildSecurityRecord(fields);
        sink(JSON.stringify(record));
        return record;
    };
}

const logSecurityEvent = createSecurityLogger();

module.exports = {
    buildSecurityRecord,
    createSecurityLogger,
    logSecurityEvent
};
