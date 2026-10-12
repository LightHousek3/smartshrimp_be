const { createHash, timingSafeEqual } = require('node:crypto');
const axios = require('axios');
const config = require('../config');
const { ApiError } = require('../utils');
const { RAG_DOCUMENT_MAX_FILE_BYTES } = require('../constants');
const { createDocumentError } = require('../utils/ragDocumentError');

// Cloudinary's signed REST API avoids adding a second upload SDK to the backend.
const settings = () => {
    const value = config.cloudinary;
    if (!value?.cloudName || !value.apiKey || !value.apiSecret || !/^[a-zA-Z0-9_-]+$/.test(value.cloudName)) {
        throw createDocumentError('RAG_STORAGE_AUTH');
    }
    return value;
};
const sign = (params, secret) => createHash('sha1').update(
    Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&') + secret,
).digest('hex');
const endpoint = (action) => `https://api.cloudinary.com/v1_1/${settings().cloudName}/raw/${action}`;
const signed = (params) => ({ ...params, api_key: settings().apiKey, signature: sign(params, settings().apiSecret) });
const createUploadIntent = (storageKey) => {
    const params = signed({ public_id: storageKey, timestamp: Math.floor(Date.now() / 1000), type: 'authenticated', overwrite: 'false' });
    return { url: endpoint('upload'), fields: params };
};
const verifyUpload = (storageKey, { publicId, version, signature }) => {
    if (publicId !== storageKey || !Number.isSafeInteger(version) || version < 1 || !/^[a-f0-9]{40}$/.test(signature || '')) return false;
    const expected = sign({ public_id: storageKey, version }, settings().apiSecret);
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
};
const download = async (storageKey) => {
    // Raw public IDs already contain the extension: do not append a second format.
    const timestamp = Math.floor(Date.now() / 1000);
    const params = signed({ public_id: storageKey, type: 'authenticated', timestamp, expires_at: timestamp + 120 });
    try {
        const { data } = await axios.get(endpoint('download'), {
            params, responseType: 'arraybuffer', timeout: 60000, maxRedirects: 0, maxContentLength: RAG_DOCUMENT_MAX_FILE_BYTES,
        });
        return Buffer.from(data);
    } catch (error) {
        const status = error.response?.status;
        if (error.code === 'ERR_BAD_RESPONSE' && /maxContentLength/i.test(error.message || '')) {
            throw createDocumentError('RAG_INVALID_CONTENT');
        }
        let message = error.response?.headers?.['x-cld-error'] || '';
        try {
            const body = error.response?.data;
            const parsed = Buffer.isBuffer(body) || body instanceof ArrayBuffer
                ? JSON.parse(Buffer.from(body).subarray(0, 8192).toString('utf8')) : body;
            message = parsed?.error?.message || message;
        } catch { /* HTML/non-JSON errors do not prove the source is missing. */ }
        if ([400, 404].includes(status) && /^Resource not found\b/i.test(message)) throw createDocumentError('RAG_SOURCE_MISSING');
        if ([401, 403].includes(status) || status === 400 && /signature|api.?key|timestamp/i.test(message)) {
            throw createDocumentError('RAG_STORAGE_AUTH');
        }
        if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) || status === 408 || status === 504) {
            throw createDocumentError('RAG_STORAGE_TIMEOUT');
        }
        throw createDocumentError('RAG_STORAGE_UNAVAILABLE');
    }
};
const destroy = async (storageKey) => {
    const params = signed({ public_id: storageKey, timestamp: Math.floor(Date.now() / 1000), type: 'authenticated', invalidate: 'true' });
    try {
        const { data } = await axios.post(endpoint('destroy'), new URLSearchParams(params), { timeout: 60000, maxRedirects: 0 });
        if (!['ok', 'not found'].includes(data.result)) throw new Error('INVALID_STORAGE_RESPONSE');
    } catch {
        throw new ApiError(503, 'Chưa thể xóa file gốc. Vui lòng thử lại thao tác xóa.');
    }
};
module.exports = { createUploadIntent, verifyUpload, download, destroy, sign, ensureConfigured: settings };
