const crypto = require('crypto');

function summarizeIdentifier(value) {
    if (!value) return 'none';
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12);
}

module.exports = {
    summarizeIdentifier
};
