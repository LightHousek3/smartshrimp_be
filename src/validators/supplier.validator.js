const Joi = require('joi');

const uuid = Joi.string().uuid({ version: 'uuidv4' }).required();
const farmParams = Joi.object({ farmId: uuid });
const supplierParams = Joi.object({
    farmId: uuid,
    supplierId: uuid,
});
/**
 * Treat blank optional supplier details as null and enforce database length limits.
 */
const nullableText = (max) => Joi.string().trim().max(max)
    .allow('', null)
    .custom((value) => value || null);
const fields = {
    name: Joi.string().trim().replace(/\s+/gu, ' ')
        .min(1)
        .max(255),
    contactName: nullableText(255),
    phone: Joi.string().trim().max(20)
        .pattern(/^\+?[0-9 ()\-.]{6,20}$/u)
        .allow('', null)
        .custom((value) => value || null),
    email: Joi.string().trim().lowercase()
        .email({ tlds: { allow: false } })
        .max(320)
        .allow('', null)
        .custom((value) => value || null),
    address: nullableText(1000),
    note: nullableText(2000),
    isActive: Joi.boolean(),
    status: Joi.string().valid('ACTIVE', 'INACTIVE'),
    supplierType: Joi.string().valid('MANUFACTURER', 'DISTRIBUTOR', 'BOTH'),
};

/**
 * Normalize cleared form values before persistence; preserve boolean false for activity updates.
 */
const normalizeOptionalFields = (value) => Object.fromEntries(
    Object.entries(value).map(([key, field]) => [key, field === '' ? null : field]),
);

/**
 * Validate destination and supplier IDs without trusting them as proof of ownership.
 * Require a version token and at least one editable field for updates.
 */
module.exports = {
    /**
     * Validate owner-directory filters and bound each page before querying.
     */
    getSuppliers: {
        params: farmParams,
        query: Joi.object({
            page: Joi.number().integer().min(1)
                .default(1),
            limit: Joi.number().integer().min(1)
                .max(100)
                .default(100),
            search: Joi.string().trim().max(255)
                .allow('')
                .default(''),
            supplierType: fields.supplierType,
            status: fields.status,
        }),
    },
    /**
     * Validate navigation and supplier IDs; the service enforces ownership.
     */
    getSupplier: { params: supplierParams },
    /**
     * Require a name and normalize optional details for a new directory entry.
     */
    createSupplier: {
        params: farmParams,
        body: Joi.object({
            ...fields,
            name: fields.name.required(),
        }).without('status', 'isActive').custom(normalizeOptionalFields),
    },
    /**
     * Require a version token and editable data; activity aliases are mutually exclusive.
     */
    updateSupplier: {
        params: supplierParams,
        body: Joi.object({
            ...fields,
            expectedUpdatedAt: Joi.date().iso().required(),
        })
            .or(...Object.keys(fields)).without('status', 'isActive')
            .custom(normalizeOptionalFields),
    },
    /**
     * Validate IDs before transactional ownership and reference checks.
     */
    deleteSupplier: { params: supplierParams },
};
