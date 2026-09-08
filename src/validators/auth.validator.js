const Joi = require('joi');

const login = {
    body: Joi.object().keys({
        email: Joi.string().required().email(),
        password: Joi.string().required(),
        deviceId: Joi.string().allow(null, ''),
    }),
};

module.exports = {
    login,
};
