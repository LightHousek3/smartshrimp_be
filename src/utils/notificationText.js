const messages = require('../constants/messages');

const TASK_REFERENCE_FIELDS = Object.freeze({
    farmId: 'farm',
    seasonId: 'season',
    assignedTo: 'assignee',
});
const uuid = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
const referenceChangePattern = () => new RegExp(
    `(^Nhiệm vụ đã cập nhật: |; )(Trang trại|Vụ nuôi|Kỹ thuật viên): (${uuid}|—) → (${uuid}|—)(?=;|$)`, 'g',
);
const keyForLabel = (label) => Object.keys(TASK_REFERENCE_FIELDS)
    .find((key) => messages.TASK.FIELD_LABELS[key] === label);
const taskUpdate = (row) => row?.type === 'TASK_UPDATED' && row.referenceType === 'task'
    && typeof row.content === 'string' && row.content.startsWith('Nhiệm vụ đã cập nhật: ');
const dateFormatter = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
});

/** Display resolved names and Vietnam deadlines; identifiers remain internal reference values. */
const taskChangeValue = (key, value, references = {}) => {
    if (value == null || value === '—') return '—';
    if (TASK_REFERENCE_FIELDS[key]) {
        return references[key]?.get(String(value).toLowerCase()) || messages.TASK.UNAVAILABLE_REFERENCES[key];
    }
    if (key === 'priority') return messages.TASK.PRIORITY_LABELS[value] || 'Không xác định';
    if (key === 'dueAt') {
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : 'Chưa xác định';
    }
    return value;
};

/** Capture names from both transaction snapshots before a task's references are changed. */
const taskReferenceNames = (tasks) => Object.fromEntries(Object.entries(TASK_REFERENCE_FIELDS)
    .map(([key, relation]) => [key, new Map(tasks
        .filter((task) => task[key] && task[relation]?.name)
        .map((task) => [task[key].toLowerCase(), task[relation].name]))]));

/** Match only system-generated reference changes, never arbitrary IDs in titles or descriptions. */
const legacyTaskReferences = (notification) => {
    if (!taskUpdate(notification)) return [];
    return [...notification.content.matchAll(referenceChangePattern())].flatMap((match) =>
        match.slice(3, 5).filter((value) => value !== '—')
            .map((id) => ({ key: keyForLabel(match[2]), id: id.toLowerCase() })));
};

/** Translate known legacy system templates on read without rewriting stored or user-authored text. */
const localizeNotification = (notification, references = {}) => {
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
            if (taskUpdate(notification)) {
                content = content.replace(referenceChangePattern(), (_, prefix, label, before, after) => {
                    const key = keyForLabel(label);
                    return `${prefix}${label}: ${taskChangeValue(key, before, references)} → ${taskChangeValue(key, after, references)}`;
                });
                content = content.replace(
                    /(^Nhiệm vụ đã cập nhật: |; )Hạn hoàn thành: (\d{4}-\d{2}-\d{2}T[\d:.]+Z|—) → (\d{4}-\d{2}-\d{2}T[\d:.]+Z|—)(?=;|$)/g,
                    (_, prefix, before, after) => `${prefix}Hạn hoàn thành: ${taskChangeValue('dueAt', before)} → ${taskChangeValue('dueAt', after)}`,
                );
            }
        }
    }
    return title === notification.title && content === notification.content
        ? notification
        : { ...notification, title, content };
};

module.exports = { localizeNotification, legacyTaskReferences, taskChangeValue, taskReferenceNames };
