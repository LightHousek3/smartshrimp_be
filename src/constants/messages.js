/**
 * Centralized message constants
 */
const messages = {
    // Auth
    AUTH: {
        LOGIN_SUCCESS: 'Đăng nhập thành công',
        LOGOUT_SUCCESS: 'Đăng xuất thành công',
        TOKEN_REFRESHED: 'Làm mới token thành công',
        PENDING_ACTIVATION: 'Tài khoản chưa được kích hoạt. Vui lòng kích hoạt tài khoản trước',
        ACCOUNT_BLOCKED: 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ bộ phận hỗ trợ',
        ACCOUNT_INACTIVE: 'Tài khoản tạm ngừng sử dụng theo quản lý nghiệp vụ',
        INVALID_CREDENTIALS: 'Email hoặc mật khẩu không chính xác',
        INVALID_REFRESH_TOKEN: 'Refresh token không hợp lệ hoặc đã hết hạn',
        UNAUTHORIZED: 'Bạn chưa đăng nhập hoặc phiên đăng nhập không hợp lệ',
        FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này',
        RESEND_TOO_SOON: 'Vui lòng đợi một lát trước khi yêu cầu gửi lại email',
    },

    // Generic CRUD
    CRUD: {
        CREATED: (resource) => `Tạo ${resource} thành công`,
        CREATED_FAIL: (resource) => `Tạo ${resource} thất bại`,
        UPDATED: (resource) => `Cập nhật ${resource} thành công`,
        UPDATED_FAIL: (resource) => `Cập nhật ${resource} thất bại`,
        DELETED: (resource) => `Xóa ${resource} thành công`,
        DELETED_FAIL: (resource) => `Xóa ${resource} thất bại`,
        FETCHED: (resource) => `Lấy thông tin ${resource} thành công`,
        NOT_FOUND: (resource) => `Không tìm thấy ${resource}`,
        ALREADY_EXISTS: (resource) => `${resource} đã tồn tại`,
        LIST_FETCHED: (resource) => `Lấy danh sách ${resource} thành công`,
    },

    // Validation
    VALIDATION: {
        FAILED: 'Xác thực dữ liệu thất bại',
        INVALID_OBJECT_ID: 'Định dạng ID không hợp lệ',
        REQUIRED_FIELD: (field) => `${field} là bắt buộc`,
    },

    // Server
    SERVER: {
        INTERNAL_ERROR: 'Lỗi máy chủ nội bộ',
        SERVICE_UNAVAILABLE: 'Dịch vụ tạm thời không khả dụng',
        TOO_MANY_REQUESTS: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
    },
};

module.exports = messages;
