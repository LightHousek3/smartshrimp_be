const messages = require('../constants/messages');

/** Translate known legacy system templates on read without rewriting stored or user-authored text. */
const localizeNotification = (notification) => {
    if (!notification) return notification;
    const { type, referenceType } = notification;
    let { title, content } = notification;
    if (type === 'TREATMENT_PROTOCOL_ABORTED' && title === 'Expert đã dừng phác đồ điều trị') {
        title = 'Chuyên gia đã dừng phác đồ điều trị';
    }
    if (typeof content === 'string') {
        if (type === 'SYSTEM' && ['protocol', 'disease_case'].includes(referenceType)) {
            content = content
                .replace(/; áp dụng theo mốc Expert đã đặt\.$/, '; áp dụng theo mốc chuyên gia đã đặt.')
                .replace(/: Expert cần quyết định chăm sóc tiếp theo\. Phác đồ nuôi đang tạm hoãn\.$/,
                    ': Chuyên gia cần quyết định chăm sóc tiếp theo. Phác đồ nuôi đang tạm hoãn.');
        }
        if (type === 'SCHEDULE_GENERATION_FAILED') {
            content = content.replace(
                /: chưa thể kích hoạt\. Kiểm tra phân công Expert, trạng thái ca, vật tư và cấu hình liệu trình\.$/,
                ': chưa thể kích hoạt. Kiểm tra phân công chuyên gia, trạng thái ca, vật tư và cấu hình liệu trình.',
            );
        }
        if (type === 'SYSTEM' && referenceType === 'product') {
            content = content.replace(
                /Tồn sổ được giữ nguyên; Owner quyết định sử dụng, trả hàng hoặc tiêu hủy theo nghiệp vụ kho\.$/,
                'Tồn sổ được giữ nguyên; chủ trại quyết định sử dụng, trả hàng hoặc tiêu hủy theo nghiệp vụ kho.',
            );
        }
        if (['SYSTEM', 'SEASON_COMPLETED'].includes(type) && referenceType === 'aquaculture_season') {
            content = content.replace(/Owner cân nhắc theo tình trạng thực tế; bản ghi vẫn hợp lệ\.$/,
                'Chủ trại cân nhắc theo tình trạng thực tế; bản ghi vẫn hợp lệ.');
        }
        if (type === 'TASK_UPDATED') {
            content = content.replace(
                /(^Nhiệm vụ đã cập nhật: |; )Ưu tiên: (LOW|NORMAL|HIGH|URGENT) → (LOW|NORMAL|HIGH|URGENT)(?=;|$)/g,
                (_, prefix, before, after) => `${prefix}Ưu tiên: ${messages.TASK.PRIORITY_LABELS[before]} → ${messages.TASK.PRIORITY_LABELS[after]}`,
            );
        }
    }
    return title === notification.title && content === notification.content
        ? notification
        : { ...notification, title, content };
};

module.exports = { localizeNotification };
