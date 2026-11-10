const prisma = require('../config/prisma');
const { ApiError, searchSubstances, checkIngredients } = require('../utils');
const { messages } = require('../constants');

const requireOwner = async (farmId, ownerId) => {
    const farm = await prisma.farm.findFirst({ where: { id: farmId, ownerId }, select: { id: true } });
    if (!farm) throw ApiError.notFound(messages.INVENTORY.FARM_NOT_FOUND);
};

const search = async (farmId, ownerId, query) => {
    await requireOwner(farmId, ownerId);
    return searchSubstances(query);
};

const check = async (farmId, ownerId, text) => {
    await requireOwner(farmId, ownerId);
    return checkIngredients(text);
};

module.exports = { search, check };
