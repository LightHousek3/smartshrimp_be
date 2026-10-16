const Joi = require('joi');

const uuid = Joi.string().uuid({ version: 'uuidv4' }).required();
const farmParams = Joi.object({ farmId: uuid });
const supplierParams = Joi.object({ farmId: uuid, supplierId: uuid });
const nullableText = (max) => Joi.string().trim().max(max).allow('', null)
    .custom((value) => value || null);
const fields = {
    name: Joi.string().trim().replace(/\s+/gu, ' ').min(1).max(255),
    contactName: nullableText(255),
    phone: Joi.string().trim().max(20).pattern(/^\+?[0-9 ()\-.]{6,20}$/u).allow('', null)
        .custom((value) => value || null),
    email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(320)
        .allow('', null).custom((value) => value || null),
    address: nullableText(1000),
    note: nullableText(2000),
};
const normalizeOptionalFields = (value) => Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, field === '' ? null : field]),
);

module.exports = {
    getSuppliers: {
        params: farmParams,
        query: Joi.object({
            page: Joi.number().integer().min(1).default(1),
            limit: Joi.number().integer().min(1).max(100).default(100),
            search: Joi.string().trim().max(255).allow('').default(''),
        }),
    },
    getSupplier: { params: supplierParams },
    createSupplier: {
        params: farmParams,
        body: Joi.object({ ...fields, name: fields.name.required() }).custom(normalizeOptionalFields),
    },
    updateSupplier: {
        params: supplierParams,
        body: Joi.object({ ...fields, expectedUpdatedAt: Joi.date().iso().required() })
            .or(...Object.keys(fields)).custom(normalizeOptionalFields),
    },
    deleteSupplier: { params: supplierParams },
};
