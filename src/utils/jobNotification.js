const { createHash } = require('node:crypto');
const logger = require('../config/logger');
const { emitNotification } = require('../realtime/notification.socket');

/** UUIDv5 makes event delivery idempotent across retries and overlapping containers. */
const eventId = (key) => {
    const namespace = Buffer.from('5f694a7488bd4eac9c4e962ea91d2909', 'hex');
    const bytes = createHash('sha1')
        .update(namespace)
        .update(JSON.stringify(key))
        .digest()
        .subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Persist the event in the caller's transaction; an existing primary key is a successful replay. */
const save = async (tx, key, data) => {
    const id = eventId([data.accountId, data.type, ...key]);
    const result = await tx.notification.createMany({
        data: [{ ...data, id }],
        skipDuplicates: true,
    });
    return result.count
        ? {
              id,
              accountId: data.accountId,
              referenceId: data.referenceId,
              referenceType: data.referenceType,
          }
        : null;
};

/**
 * Publish job notifications after persistence and let the inbox remain available if realtime delivery
 * fails.
 */
const deliver = (notices) => {
    for (const notice of notices.filter(Boolean)) {
        try {
            emitNotification(notice.accountId, 'notification:new', notice);
        } catch {
            logger.warn(
                'Background notification remains persisted after realtime delivery failed.',
            );
        }
    }
};

module.exports = { eventId, save, deliver };
