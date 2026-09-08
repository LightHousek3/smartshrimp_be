/**
 * Pick specified keys from an object.
 * Useful for extracting query parameters for filtering/pagination.
 *
 * @param {Object} object - Source object
 * @param {string[]} keys - Keys to pick
 * @returns {Object} Object with only the picked keys
 *
 * @example
 * const filter = pick(req.query, ['status', 'role']);
 */
const pick = (object, keys) => {
    return keys.reduce((obj, key) => {
        if (object && Object.prototype.hasOwnProperty.call(object, key)) {
            obj[key] = object[key];
        }
        return obj;
    }, {});
};

module.exports = pick;
