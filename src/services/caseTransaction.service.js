const prisma = require('../config/prisma');
const { ApiError } = require('../utils');
const { messages } = require('../constants');

/** Retry serialization failures before any post-commit delivery occurs. */
module.exports = async work => {
    for (let attempt = 0; attempt < 3; attempt++) {
        try { return await prisma.$transaction(work, { isolationLevel: 'Serializable' }); } catch (error) {
            const conflict = error.code === 'P2034' || error.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code);
            if (conflict && attempt < 2) continue;
            if (conflict) throw ApiError.conflict(messages.DISEASE_CASE.CONFLICT);
            throw error;
        }
    }
};
