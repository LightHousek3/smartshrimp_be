const PROTOCOL_TYPE = Object.freeze({ PRODUCTION: 'PRODUCTION', TREATMENT: 'TREATMENT' });
const PROTOCOL_STATUS = Object.freeze({
    DRAFT: 'DRAFT', PENDING_APPROVAL: 'PENDING_APPROVAL', APPROVED: 'APPROVED',
    REJECTED: 'REJECTED', SUPERSEDED: 'SUPERSEDED', CANCELLED: 'CANCELLED', ABORTED: 'ABORTED',
});
const PROTOCOL_MESSAGE = Object.freeze({
    FETCHED: 'Lấy dữ liệu phác đồ thành công.',
    REVIEWED: 'Đã lưu quyết định phác đồ.',
    NOT_FOUND: 'Không tìm thấy phác đồ trong phạm vi quản lý.',
    SEASON_NOT_FOUND: 'Không tìm thấy vụ nuôi trong phạm vi quản lý.',
    CONFLICT: 'Phác đồ hoặc vụ nuôi đã thay đổi. Vui lòng tải lại trước khi quyết định.',
    CLOSED: 'Không thể duyệt phác đồ khi vụ nuôi đã kết thúc hoặc trang trại không hoạt động.',
    INVALID_CASE: 'Ca bệnh không hợp lệ hoặc đã được giải quyết.',
    EMPTY: 'Phác đồ phải có ít nhất một hạng mục và giờ thực hiện hợp lệ.',
    PRODUCT: 'Vật tư đã liên kết phải đang hoạt động và thuộc cùng trang trại.',
    PREDECESSOR: 'Phiên bản thay thế không còn khớp với phác đồ đang áp dụng.',
    INVALID_DAY: 'Ngày nằm ngoài thời gian của phác đồ.',
});
module.exports = { PROTOCOL_TYPE, PROTOCOL_STATUS, PROTOCOL_MESSAGE };
