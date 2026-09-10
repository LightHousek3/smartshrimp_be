/**
 * Centralized message constants
 */
const messages = {
    ACCOUNT: {
        LIST_FETCHED: 'Account list fetched successfully',
        FETCHED: 'Account details fetched successfully',
        CREATED: 'Account created successfully',
        NOT_FOUND: 'Account not found',
        EMAIL_ALREADY_EXISTS: 'Email is already in use',
        INVALID_MANAGING_OWNER: 'Managing owner must be a farm owner',
        OWNER_NOT_ACTIVE: 'Managing owner must be active',
        ACTIVATION_EMAIL_SENT: 'Activation email sent successfully',
        ACTIVATION_RESEND_TOO_SOON: 'Please wait before resending the activation email',
        ACTIVATION_NOT_PENDING: 'Only pending accounts can receive an activation email',
        ACTIVATION_EMAIL_FAILED: 'Unable to send the activation email',
        STATUS_UPDATED: 'Account status updated successfully',
        STATUS_UNCHANGED: 'New status must be different from the current status',
        STATUS_PENDING_PROTECTED: 'Pending accounts must be activated through email verification',
        ADMIN_STATUS_PROTECTED: 'Admin account status cannot be changed here',
        STAFF_HAS_ACTIVE_ASSIGNMENT: 'Assigned staff must be replaced before deactivation',
        OWNER_HAS_ACTIVE_STAFF: 'Owner staff must be disabled or transferred before deactivation',
        OWNER_HAS_OPEN_SEASON: 'Owner with an open season cannot be deactivated',
    },

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
