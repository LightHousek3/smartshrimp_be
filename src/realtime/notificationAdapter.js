const { createAdapter } = require('@socket.io/redis-adapter');
const { openRedisConnection } = require('../config/redisConnection');

const OUTAGE_MESSAGE = 'Realtime delivery is local while Redis is unavailable.';
const CONNECTION_METHODS = ['on', 'off'];

const bind = (client, methods) =>
    Object.fromEntries(methods.map((method) => [method, client[method].bind(client)]));

/** The adapter does not await Pub/Sub commands. Handle rejections without interrupting local delivery. */
const openNotificationAdapter = (url, prefix) => {
    if (!url) return {};
    const publisher = openRedisConnection(url, 'realtime publisher', OUTAGE_MESSAGE);
    const subscriber = openRedisConnection(url, 'realtime subscriber', OUTAGE_MESSAGE, {
        subscribe: true,
    });
    const close = () => {
        publisher?.close();
        subscriber?.close();
    };
    if (!publisher || !subscriber) {
        close();
        return {};
    }

    const pub = publisher.client;
    const sub = subscriber.client;
    const publish = (...args) => {
        if (pub.isReady) void pub.publish(...args).catch(publisher.warn);
    };
    const subscribe = (method) => (...args) => {
        void sub[method](...args).catch(() => {
            subscriber.warn();
            // If the first subscription was interrupted, restore it on the next connection.
            if (sub.isOpen && !sub.isReady) sub.once('ready', () => subscribe(method)(...args));
        });
    };
    const unsubscribe = (method) => (...args) => {
        if (sub.isReady) void sub[method](...args).catch(subscriber.warn);
    };
    const adapter = createAdapter(
        { ...bind(pub, [...CONNECTION_METHODS, 'pSubscribe', 'sSubscribe', 'sendCommand']), publish },
        {
            ...bind(sub, CONNECTION_METHODS),
            pSubscribe: subscribe('pSubscribe'),
            subscribe: subscribe('subscribe'),
            pUnsubscribe: unsubscribe('pUnsubscribe'),
            unsubscribe: unsubscribe('unsubscribe'),
        },
        { key: `${prefix}:notifications`, publishOnSpecificResponseChannel: true },
    );
    return { adapter, close };
};

module.exports = { openNotificationAdapter };
