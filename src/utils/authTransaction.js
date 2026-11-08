const prisma = require('../config/prisma');
const { createAuthError } = require('./authPolicy');

// Retry the whole atomic operation, including fresh state/time reads.
const authTransaction = async (work) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await prisma.$transaction(work, { isolationLevel: 'Serializable' });
        } catch (error) {
            if (!['P2034', 'P2002'].includes(error.code)) throw error;
            if (attempt === 2) throw createAuthError('VERIFICATION_CONFLICT', 409);
        }
    }
};

module.exports = authTransaction;
