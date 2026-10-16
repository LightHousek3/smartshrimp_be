const Joi = require('joi');
const { hasOverlappingStages } = require('../utils/productionProtocol');
const {
    messages,
    OPERATION_TYPE,
    DOSE_BASIS,
    PRODUCTION_PROTOCOL_UNITS,
    PRODUCTION_PROTOCOL_CATEGORIES,
    allowedProductionProtocolDoseBases,
} = require('../constants');

const uuid = () => Joi.string().uuid();
// Strings avoid silently rounding PostgreSQL NUMERIC input at the JSON boundary.
const decimal = (integerDigits, scale, zero = false) => Joi.string().pattern(
    new RegExp(`^(?:0|[1-9][0-9]{0,${integerDigits - 1}})(?:\\.[0-9]{1,${scale}})?$`),
).custom((value, helpers) => (zero || Number(value) > 0 ? value : helpers.error('any.invalid')));

/** An item needs a catalog product or a named suggestion; dose values fit NUMERIC(14,4). */
const item = Joi.object({
    id: uuid(),
    operationType: Joi.string().valid(...Object.values(OPERATION_TYPE)).required(),
    productId: uuid().allow(null).default(null),
    recommendedProductName: Joi.string().trim().max(255).allow(null).default(null),
    recommendedCategory: Joi.string().valid(...PRODUCTION_PROTOCOL_CATEGORIES).allow(null).default(null),
    repeatIntervalDays: Joi.number().integer().min(1).max(30).default(1),
    doseBasis: Joi.string().valid(...Object.values(DOSE_BASIS)).required(),
    doseValue: decimal(10, 4).required(),
    doseUnit: Joi.string().valid(...PRODUCTION_PROTOCOL_UNITS).required(),
    instructions: Joi.string().trim().max(4000).allow('', null).default(null),
}).custom((value, helpers) => (
    value.productId || value.recommendedProductName ? value : helpers.error('any.invalid')
)).unknown(false);
/** Farm wall-clock time supports optional seconds and milliseconds, without a date or timezone. */
const time = () => Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/).allow(null);

/** Null meal numbers represent non-meal treatments; missing times are allowed until submission. */
const meal = Joi.object({
    id: uuid(),
    mealNumber: Joi.number().integer().min(1).max(32767).allow(null).default(null),
    plannedTime: time().default(null),
    items: Joi.array().items(item).min(1).max(100).required(),
}).unknown(false);

/**
 * API offsets are zero-based and inclusive; reserve one int32 value for database DOC conversion.
 * Dose eligibility uses the stage's starting age, so every item must be valid from its first day.
 */
const stage = Joi.object({
    id: uuid(),
    startDayOffset: Joi.number().integer().min(0).max(2147483646).required(),
    endDayOffset: Joi.number().integer().min(Joi.ref('startDayOffset')).max(2147483646).required(),
    meals: Joi.array().items(meal).min(1).max(50).required(),
}).custom((value, helpers) => {
    const invalid = value.meals.some((group) => group.items.some((entry) => (
        !allowedProductionProtocolDoseBases(entry.operationType, value.startDayOffset).includes(entry.doseBasis)
    )));
    return invalid ? helpers.error('any.invalid') : value;
}).unknown(false);

/** Reject overlapping day ranges, duplicate identities and graphs exceeding 1000 total items. */
const stages = Joi.array().items(stage).max(50).custom((value, helpers) => {
    if (hasOverlappingStages(value)) {
        return helpers.error('stages.overlap');
    }
    const ids = value.flatMap((phase) => [phase.id, ...phase.meals.flatMap((group) => (
        [group.id, ...group.items.map((entry) => entry.id)]
    ))]).filter(Boolean);
    const count = value.reduce((sum, phase) => sum + phase.meals.reduce((n, group) => n + group.items.length, 0), 0);
    return ids.length !== new Set(ids).size || count > 1000 ? helpers.error('any.invalid') : value;
}).messages({ 'stages.overlap': messages.PRODUCTION_PROTOCOL.STAGE_OVERLAP });

/** Shared editable fields; status, version and audit fields remain owned by the service. */
const header = {
    title: Joi.string().trim().max(500),
    summary: Joi.string().trim().max(4000).allow('', null),
    allowedVariancePct: decimal(3, 2, true).custom((value, helpers) => (
        Number(value) <= 100 ? value : helpers.error('any.invalid')
    )),
    rollingWindowDays: Joi.number().integer().min(1).max(14),
    stages,
};
const seasonParams = Joi.object({ seasonId: uuid().required() });
const protocolParams = seasonParams.keys({ protocolId: uuid().required() });

/** GET season context accepts only the scoped season identity and no query options. */
const getSeason = {
    params: seasonParams,
    query: Joi.object({}).unknown(false),
};

/** Bound version pagination to limit the amount of nested protocol content loaded per request. */
const list = {
    params: seasonParams,
    query: Joi.object({
        page: Joi.number().integer().min(1).max(100000).default(1),
        limit: Joi.number().integer().min(1).max(50).default(20),
    }).unknown(false),
};

/** Product catalog search and pagination; farm scope and active status are enforced by the service. */
const catalog = {
    params: seasonParams,
    query: Joi.object({
        search: Joi.string().trim().max(255).allow('').default(''),
        page: Joi.number().integer().min(1).max(100000).default(1),
        limit: Joi.number().integer().min(1).max(100).default(50),
    }).unknown(false),
};

/** Protocol identity must be supplied together with its parent season identity. */
const detail = {
    params: protocolParams,
    query: Joi.object({}).unknown(false),
};

/**
 * Empty drafts are valid; the service requires complete content when submitForApproval is true.
 * The client may select a template but cannot set the persisted source or version fields directly.
 */
const create = {
    params: seasonParams,
    body: Joi.object({
        ...header,
        templateId: uuid().allow(null),
        submitForApproval: Joi.boolean().default(false),
        title: header.title.required(),
        allowedVariancePct: header.allowedVariancePct.required(),
        rollingWindowDays: header.rollingWindowDays.default(7),
        stages: stages.default([]),
    }).unknown(false),
};

/** PATCH requires a current content token and at least one editable field; omitted fields stay intact. */
const update = {
    params: protocolParams,
    body: Joi.object({
        ...header,
        templateId: uuid().allow(null),
        submitForApproval: Joi.boolean().default(false),
        revision: Joi.string().pattern(/^[a-f0-9]{64}$/).required(),
    }).or(...Object.keys(header)).unknown(false),
};

/** Cancellation requires the current content token and a nonblank reason for the status history. */
const cancel = {
    params: protocolParams,
    body: Joi.object({
        revision: Joi.string().pattern(/^[a-f0-9]{64}$/).required(),
        reason: Joi.string().trim().max(2000).required(),
    }).unknown(false),
};

/** Standalone submission accepts only a content token; the service revalidates saved items. */
const submit = {
    params: protocolParams,
    body: Joi.object({ revision: Joi.string().pattern(/^[a-f0-9]{64}$/).required() }).unknown(false),
};

/** Template listing shares catalog pagination; farm, species and availability checks stay in the service. */
const templates = {
    params: seasonParams,
    query: catalog.query,
};

/** Template identity is season-scoped and cannot be accompanied by arbitrary query fields. */
const templateDetail = {
    params: seasonParams.keys({ templateId: uuid().required() }),
    query: Joi.object({}).unknown(false),
};

module.exports = {
    getSeason,
    list,
    catalog,
    detail,
    create,
    update,
    cancel,
    submit,
    templates,
    templateDetail,
};
