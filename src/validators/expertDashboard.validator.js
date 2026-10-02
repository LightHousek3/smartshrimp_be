const Joi = require('joi');

const getDashboard = {
    query: Joi.object({}).unknown(false),
};

module.exports = { getDashboard };
