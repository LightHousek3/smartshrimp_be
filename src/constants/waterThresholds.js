/**
 * waterThresholds.js
 * ==========================
 * Ngưỡng cảnh báo chất lượng nước theo loại tôm, dùng cho:
 *  - F1 "Nhập nhật ký đo nước": so sánh từng chỉ số lúc nhập, vượt ngưỡng ->
 *    tạo notification `water_threshold_exceeded` cho chủ trại (BR-NOTI-03).
 *  - F4 "Xem thống kê chất lượng nước": tính % mẫu vượt ngưỡng.
 *
 * NGUỒN SỐ LIỆU (DRAFT 2026-10-08): tổng hợp từ tài liệu trực tuyến
 * (tôm thẻ chân trắng L. vannamei; tôm sú P. monodon).
 * ⚠️ TEAM NUÔI TRỒNG BẮT BUỘC rà soát và điều chỉnh trước khi dùng production.
 *
 * Quy ước: vượt ngưỡng = giá trị nằm NGOÀI [min, max].
 * Các chỉ số một phía (vd. NH3 chỉ có max) thì phía còn lại để null = không giới hạn.
 * Đây là ngưỡng CẢNH BÁO vận hành, khác với khoảng vật lý ở DB CHECK
 * (temp 0–50, pH 0–14, các chỉ số ≥ 0) — DB CHECK vẫn là tuyến phòng thủ cuối.
 *
 * Lưu ý về NH3: cột `nh3_mg_l` trong DB chưa rõ là NH3 tự do hay TAN
 * (total ammonia nitrogen). Ngưỡng dưới đây áp cho giá trị đo thực tế được nhập;
 * team cần chốt định nghĩa cột, lý tưởng là quy đổi NH3 tự do từ TAN + pH + nhiệt độ.
 */

// Dùng đúng key SHRIMP_TYPE của src/constants/index.js: WHITELEG / BLACK_TIGER
const WATER_THRESHOLDS = {
    WHITELEG: {
        // Tôm thẻ chân trắng (Litopenaeus vannamei)
        // Nguồn: tổng hợp nhiều nghiên cứu — temp tối ưu 25–33 (tốt nhất 28–30);
        // pH 7.5–8.5; DO > 4 (tối ưu ≥ 5); độ mặn 15–25 (chịu được 5–35);
        // NH3 < 0.1; NO2 < 0.5; kiềm > 120; H2S < 0.05.
        temperatureC:       { min: 25,  max: 33,  unit: '°C' },
        ph:                 { min: 7.5, max: 8.5, unit: 'pH' },
        dissolvedOxygenMgL: { min: 4.0, max: null, unit: 'mg/L' },
        salinityPpt:        { min: 10,  max: 30,  unit: 'ppt' },
        nh3MgL:             { min: null, max: 0.1, unit: 'mg/L' },
        no2MgL:             { min: null, max: 0.5, unit: 'mg/L' },
        alkalinityMgLCaCO3: { min: 100, max: 250, unit: 'mg/L CaCO3' },
        h2sMgL:             { min: null, max: 0.05, unit: 'mg/L' },
    },
    BLACK_TIGER: {
        // Tôm sú (Penaeus monodon)
        // Nguồn: tổng hợp nhiều nghiên cứu — temp tối ưu 26–32 (tốt nhất 26–29);
        // pH 7.5–8.5; DO tối thiểu 4; độ mặn 10–25 (chịu được 5–32);
        // NH3-N tối đa 0.1; NO2-N tối đa 0.5–1.0 (lấy mức chặt 0.5);
        // H2S < 0.05; kiềm 100–200.
        temperatureC:       { min: 26,  max: 32,  unit: '°C' },
        ph:                 { min: 7.5, max: 8.5, unit: 'pH' },
        dissolvedOxygenMgL: { min: 4.0, max: null, unit: 'mg/L' },
        salinityPpt:        { min: 10,  max: 30,  unit: 'ppt' },
        nh3MgL:             { min: null, max: 0.1, unit: 'mg/L' },
        no2MgL:             { min: null, max: 0.5, unit: 'mg/L' },
        alkalinityMgLCaCO3: { min: 100, max: 250, unit: 'mg/L CaCO3' },
        h2sMgL:             { min: null, max: 0.05, unit: 'mg/L' },
    },
};

// Map tên field camelCase (BE) -> key ngưỡng, để loop kiểm tra.
// Thêm/xóa chỉ số đo trong tương lai chỉ cần sửa map này + WATER_THRESHOLDS.
const THRESHOLD_FIELD_MAP = {
    temperatureC: 'temperatureC',
    ph: 'ph',
    dissolvedOxygenMgL: 'dissolvedOxygenMgL',
    salinityPpt: 'salinityPpt',
    nh3MgL: 'nh3MgL',
    no2MgL: 'no2MgL',
    alkalinityMgLCaCO3: 'alkalinityMgLCaCO3',
    h2sMgL: 'h2sMgL',
};

/**
 * Kiểm tra các chỉ số đo so với ngưỡng của loại tôm.
 * @param {string} shrimpType 'WHITELEG' | 'BLACK_TIGER' (đúng enum SHRIMP_TYPE)
 * @param {Object} values object các chỉ số (Decimal hoặc number, null = không đo)
 * @returns {Array<{field, value, min, max, unit}>} danh sách chỉ số vượt ngưỡng
 */
const checkWaterThresholds = (shrimpType, values = {}) => {
    const thresholds = WATER_THRESHOLDS[shrimpType];
    if (!thresholds) {
        throw new Error(`Unknown shrimp type for water thresholds: ${shrimpType}`);
    }
    const exceeded = [];
    for (const [field, key] of Object.entries(THRESHOLD_FIELD_MAP)) {
        const raw = values[field];
        if (raw === null || raw === undefined || raw === '') continue; // không đo -> bỏ qua
        const value = Number(raw);
        if (Number.isNaN(value)) continue;
        const { min, max, unit } = thresholds[key];
        if ((min !== null && value < min) || (max !== null && value > max)) {
            exceeded.push({ field, value, min, max, unit });
        }
    }
    return exceeded;
};

module.exports = { WATER_THRESHOLDS, THRESHOLD_FIELD_MAP, checkWaterThresholds };
