const axios = require('axios');
const config = require('../config');
const { ApiError } = require('../utils');
const { httpStatus, messages } = require('../constants');

const endpoint = 'https://rsapi.goong.io/Geocode';

/** Keep the REST key server-side and return only validated coordinates. */
const geocode = async ({ address, latitude, longitude }) => {
    if (!config.goong.apiKey) {
        throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, messages.FARM.GEOCODE_NOT_CONFIGURED);
    }

    let response;
    try {
        response = await axios.get(endpoint, {
            params: {
                ...(address ? { address } : { latlng: `${latitude},${longitude}` }),
                api_key: config.goong.apiKey,
            },
            timeout: 10000,
        });
    } catch (error) {
        const status = error.response?.status === 429
            ? httpStatus.TOO_MANY_REQUESTS
            : error.code === 'ECONNABORTED'
                ? httpStatus.GATEWAY_TIMEOUT
                : httpStatus.BAD_GATEWAY;
        throw new ApiError(status, messages.FARM.GEOCODE_UNAVAILABLE);
    }

    const payload = response.data;
    if (payload?.status === 'ZERO_RESULTS') return null;
    if (payload?.status !== 'OK' || !Array.isArray(payload.results)) {
        throw new ApiError(httpStatus.BAD_GATEWAY, messages.FARM.GEOCODE_UNAVAILABLE);
    }
    const first = payload.results[0];
    if (!first) return null;
    const lat = first.geometry?.location?.lat;
    const lng = first.geometry?.location?.lng;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
        typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new ApiError(httpStatus.BAD_GATEWAY, messages.FARM.GEOCODE_UNAVAILABLE);
    }
    return {
        latitude: lat,
        longitude: lng,
        displayAddress: typeof first.formatted_address === 'string'
            ? first.formatted_address : null,
    };
};

module.exports = { geocode };
