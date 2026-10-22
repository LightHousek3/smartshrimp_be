const ApiError = require('./ApiError');

/**
 * Reject operational use until the owner completes the product's essential label facts.
 * Explicit false and zero are valid facts; notes and supporting images are optional.
 * @param {object} product Product with its manufacturer ID and compliance relation.
 * @throws {ApiError} When required facts are absent or the withdrawal period is invalid.
 */
const requireCompleteInventoryProduct = (product) => {
    const compliance = product?.compliance;
    const textPresent = (value) => typeof value === 'string' && value.trim().length > 0;
    if (!product || !textPresent(product.manufacturerId)
        || !compliance || !['feed', 'environment', 'dual_purpose', 'medicine'].includes(compliance.regulatoryType)
        || !textPresent(compliance.registrationNumber)
        || !textPresent(compliance.ingredientsText)
        || !textPresent(compliance.usageInstructions)
        || typeof compliance.containsAntibiotic !== 'boolean'
        || compliance.withdrawalDays == null
        || !Number.isFinite(Number(compliance.withdrawalDays))
        || Number(compliance.withdrawalDays) < 0) {
        throw ApiError.badRequest('Vui lòng nhập đầy đủ nhà sản xuất, loại sản phẩm, mã số tiếp nhận, thành phần, hướng dẫn sử dụng, kháng sinh và thời gian ngừng trước khi sử dụng vật tư');
    }
};

module.exports = { requireCompleteInventoryProduct };
