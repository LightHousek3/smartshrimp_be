const Joi = require('joi');
const messages = require('../constants/messages');

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

const phoneLayout = /^(?:\+[1-9]|[0-9]|\([0-9]+\))(?:[0-9]|\([0-9]+\)|[ .-]+(?=[0-9(]))*$/u;
const compactPhone = /^\+?[0-9]{6,15}$/u;
const phone = Joi.string().trim().max(32).custom((value, helpers) => {
    const compact = value.replace(/[ ().-]/gu, '');
    if (!phoneLayout.test(value) || !compactPhone.test(compact) || !/[1-9]/u.test(compact)) {
        return helpers.error('any.invalid');
    }
    return compact;
}).messages({
    'any.required': messages.SUPPLIER.PHONE_REQUIRED,
    'string.empty': messages.SUPPLIER.PHONE_REQUIRED,
    'string.base': messages.SUPPLIER.PHONE_INVALID,
    'string.max': messages.SUPPLIER.PHONE_INVALID,
    'any.invalid': messages.SUPPLIER.PHONE_INVALID,
});

const fields = {
    name: Joi.string().trim().replace(/\s+/gu, ' ')
        .label('Tên nhà cung cấp')
        .messages({
            'any.required': 'Vui lòng nhập tên nhà cung cấp.',
            'string.empty': 'Vui lòng nhập tên nhà cung cấp.',
        })
        .min(1)
        .max(255),
    contactName: nullableText(255),
    phone,
    email: Joi.string().trim().lowercase()
        .email({ tlds: { allow: false } })
        .max(320)
        .allow('', null)
        .custom((value) => value || null),
    address: Joi.string().trim().min(1).max(1000),
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
const requiredContactFields = {
    name: fields.name.required(),
    phone: fields.phone.required(),
    address: fields.address.required(),
};
const manufacturer = Joi.object({
    ...requiredContactFields,
    name: requiredContactFields.name.label('Tên nhà sản xuất').messages({
        'any.required': 'Vui lòng nhập tên nhà sản xuất.',
        'string.empty': 'Vui lòng nhập tên nhà sản xuất.',
    }),
    supplierType: Joi.string().lowercase().valid('manufacturer', 'both').default('manufacturer'),
    contactName: fields.contactName,
    email: fields.email,
    note: fields.note,
}).custom(normalizeOptionalFields);

/**
 * Validate destination and supplier IDs without trusting them as proof of ownership.
 * Require a version token and at least one editable field for updates.
 */
module.exports = {
    manufacturer,
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
     * Require name, phone and address; normalize optional details for a new directory entry.
     */
    createSupplier: {
        params: farmParams,
        body: Joi.object({
            ...fields,
            ...requiredContactFields,
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
