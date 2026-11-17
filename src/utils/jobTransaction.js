const prisma = require('../config/prisma');

/** Retry only rolled-back serialization conflicts; delivery must remain outside this callback. */
module.exports = async (work, options = {}) => {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await prisma.$transaction(work, { isolationLevel: 'Serializable', ...options });
        } catch (error) {
            const conflict =
                error.code === 'P2034' ||
                (error.code === 'P2010' && ['40001', '40P01'].includes(error.meta?.code));
            if (!conflict || attempt === 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
};
