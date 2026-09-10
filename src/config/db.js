const logger = require('./logger');
const prisma = require('./prisma');

/**
 * Connect to Postgre + Prisma with retry logic
 */
const connectDB = async ({ maxAttempts = 5, retryDelayMs = 2000 } = {}) => {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            await prisma.$connect();
            logger.info('Connected to PostgreSQL via Prisma');
            return;
        } catch (error) {
            lastError = error;
            logger.error(`Database connection attempt ${attempt}/${maxAttempts} failed`);

            if (attempt < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
        }
    }

    throw lastError;
};

module.exports = connectDB;
