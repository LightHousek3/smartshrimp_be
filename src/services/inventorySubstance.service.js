const prisma = require('../config/prisma');
const { ApiError, searchSubstances, checkIngredients } = require('../utils');
const { messages } = require('../constants');

/**
 * Require the farm to belong to the account before exposing inventory substance tools.
 */
const requireOwner = async (farmId, ownerId) => {
    const farm = await prisma.farm.findFirst({ where: { id: farmId, ownerId }, select: { id: true } });
    if (!farm) throw ApiError.notFound(messages.INVENTORY.FARM_NOT_FOUND);
};

/**
 * Provide a catalog search after validating the owner's farm context.
 */
const search = async (farmId, ownerId, query) => {
    await requireOwner(farmId, ownerId);
    return searchSubstances(query);
};

/**
 * Screen ingredient text for catalog matches after validating the owner's farm context.
 */
const check = async (farmId, ownerId, text) => {
    await requireOwner(farmId, ownerId);
    return checkIngredients(text);
};

module.exports = { search, check };
