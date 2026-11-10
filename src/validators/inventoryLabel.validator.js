const Joi = require('joi');
const { INVENTORY_LABEL_LIMITS: { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES }, messages } = require('../constants');

const scanLabel = {
    params: Joi.object({ farmId: Joi.string().uuid({ version: 'uuidv4' }).required() }),
    body: Joi.object({
        images: Joi.array().items(Joi.object({
            data: Joi.string().base64().max(4 * Math.ceil(MAX_IMAGE_BYTES / 3)),
            url: Joi.string().uri({ scheme: ['https'] }).max(2048),
        }).xor('data', 'url')).min(1).max(MAX_IMAGES).required(),
    }).custom((value, helpers) => {
        const bytes = value.images.reduce((sum, image) => sum + (image.data ? Buffer.byteLength(image.data, 'base64') : 0), 0);
        return bytes <= MAX_TOTAL_BYTES ? value : helpers.message({ custom: messages.INVENTORY_LABEL.TOTAL_SIZE_EXCEEDED });
    }),
};

module.exports = { scanLabel };
