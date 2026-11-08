const { createHash } = require('node:crypto');

const cloudinarySignature = (params, secret) => createHash('sha1').update(
    Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&') + secret,
).digest('hex');

module.exports = cloudinarySignature;
