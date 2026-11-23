const config = require('./index');
const { openRedisConnection, runRedisCommand } = require('./redisConnection');

let cache;
let rateLimits;

const start = () => {
    const { url, rateLimitUrl } = config.redis || {};
    if (url && !cache) {
        cache = openRedisConnection(url, 'cache', 'Reads will use the underlying sources.');
    }
    if (rateLimitUrl && !rateLimits) {
        rateLimits = openRedisConnection(rateLimitUrl, 'rate limits', 'Shared quotas are unavailable.');
    }
};

const stop = () => {
    cache?.close();
    rateLimits?.close();
    cache = undefined;
    rateLimits = undefined;
};

const runCacheCommand = (command) => runRedisCommand(cache, command).catch(() => null);
const get = (key) => runCacheCommand((connection) => connection.get(key));
const set = (key, value, ttlSeconds) =>
    runCacheCommand((connection) => connection.set(key, value, { EX: ttlSeconds }));
const runRateLimitScript = (script, key, ...args) =>
    runRedisCommand(rateLimits, (connection) => connection.eval(script, {
        keys: [key],
        arguments: args.map(String),
    }));

module.exports = { start, stop, get, set, runRateLimitScript };
