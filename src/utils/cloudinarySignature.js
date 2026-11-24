const { createHash } = require('node:crypto');

/**
 * Sign the canonical key-sorted parameter string required by Cloudinary.
 */
const cloudinarySignature = (params, secret) => createHash('sha1').update(
    Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&') + secret,
).digest('hex');

module.exports = cloudinarySignature;
