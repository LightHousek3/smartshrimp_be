const { runRateLimitScript } = require('../config/redis');
const { httpStatus, messages } = require('../constants');
const ApiError = require('../utils/ApiError');

const INCREMENT = `
    local hits = redis.call('INCR', KEYS[1])
    redis.call('PEXPIRE', KEYS[1], ARGV[1], 'NX')
    return {hits, redis.call('PEXPIRETIME', KEYS[1])}
`;

// A successful response may finish after the window that admitted it has expired.
const REFUND = `
    if redis.call('PEXPIRETIME', KEYS[1]) == tonumber(ARGV[1]) then
        local hits = tonumber(redis.call('GET', KEYS[1]))
        if hits and hits > 0 then redis.call('DECR', KEYS[1]) end
    end
    return 0
`;

class RedisRateLimitUnavailable extends ApiError {
    constructor() {
        super(httpStatus.SERVICE_UNAVAILABLE, messages.SERVER.SERVICE_UNAVAILABLE);
    }
}

class RedisRateLimitStore {
    constructor(prefix) {
        this.prefix = prefix;
    }

    init(options) {
        this.windowMs = options.windowMs;
    }

    async increment(key) {
        try {
            const [totalHits, expiresAt] = await runRateLimitScript(
                INCREMENT, this.prefix + key, this.windowMs,
            );
            return { totalHits, resetTime: new Date(expiresAt) };
        } catch {
            throw new RedisRateLimitUnavailable();
        }
    }

    async decrement(key, resetTime) {
        // Keep the hit if Redis is unavailable when the response finishes.
        await runRateLimitScript(REFUND, this.prefix + key, resetTime.getTime()).catch(() => {});
    }

    async resetKey(key) {
        await runRateLimitScript("return redis.call('DEL', KEYS[1])", this.prefix + key);
    }
}

module.exports = { RedisRateLimitStore, RedisRateLimitUnavailable };
