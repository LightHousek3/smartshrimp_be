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
        ONLY_PENDING_UPDATABLE: 'Only pending accounts can be updated',
        PENDING_UPDATE_SUCCESS: 'Account updated and activation invitation sent successfully',
    },

    NOTIFICATION: {
        LIST_FETCHED: 'Lấy danh sách thông báo thành công',
        FETCHED: 'Lấy chi tiết thông báo thành công',
        NOT_FOUND: 'Không tìm thấy thông báo',
        INVALID_CURSOR: 'Không tìm thấy mốc phân trang thông báo',
    },

    PERSONNEL: {
        LIST_FETCHED: 'Lấy danh sách nhân sự thành công',
        FETCHED: 'Lấy chi tiết nhân sự thành công',
        NOT_FOUND: 'Không tìm thấy nhân sự',
        INVALID_CURSOR: 'Không tìm thấy mốc phân trang nhân sự',
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
        RESEND_TOO_SOON: 'Vui lòng đợi 60 giây trước khi yêu cầu mã OTP mới',
        OTP_SENT: 'Nếu email hợp lệ, mã OTP đã được gửi',
        OTP_VERIFIED: 'Xác thực OTP thành công',
        INVALID_OTP: 'Mã OTP không hợp lệ',
        OTP_EXPIRED: 'Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới',
        OTP_ATTEMPTS_EXCEEDED:
            'Mã OTP đã bị vô hiệu hóa do nhập sai quá nhiều lần. Vui lòng yêu cầu mã mới',
        INVALID_ACTION_TOKEN: 'Phiên xác thực không hợp lệ hoặc đã hết hạn',
        ACCOUNT_ALREADY_ACTIVATED: 'Tài khoản đã được kích hoạt hoặc không thể kích hoạt',
        ACTIVATION_SUCCESS: 'Kích hoạt tài khoản thành công',
        PASSWORD_RESET_SUCCESS: 'Đặt lại mật khẩu thành công',
        EMAIL_DELIVERY_FAILED: 'Không thể gửi email xác thực. Vui lòng thử lại sau',
    },

    // Profile
    PROFILE: {
        FETCH_SUCCESS: 'Lấy hồ sơ cá nhân thành công',
        UPDATE_SUCCESS: 'Cập nhật hồ sơ cá nhân thành công',
        PASSWORD_CHANGE_SUCCESS: 'Đổi mật khẩu thành công',
        NOT_FOUND: 'Không tìm thấy hồ sơ cá nhân',
        CURRENT_PASSWORD_INCORRECT: 'Mật khẩu hiện tại không chính xác',
        PASSWORD_REUSE_NOT_ALLOWED: 'Mật khẩu mới không được trùng với mật khẩu hiện tại',
        UPDATE_CONFLICT: 'Hồ sơ đã thay đổi. Vui lòng tải lại và thử lại',
    },

    FARM: {
        LIST_FETCHED: 'Lấy danh sách trang trại thành công',
        FETCHED: 'Lấy chi tiết trang trại thành công',
        CREATED: 'Tạo trang trại thành công',
        UPDATED: 'Cập nhật trang trại thành công',
        DELETED: 'Xóa trang trại thành công',
        NOT_FOUND: 'Không tìm thấy trang trại',
        NAME_ALREADY_EXISTS: 'Tên trang trại đã tồn tại trong danh sách đang hoạt động',
        OWNER_NOT_ELIGIBLE: 'Chỉ chủ trang trại đang hoạt động mới có thể tạo trang trại',
        HAS_OPEN_SEASON: 'Không thể xóa trang trại đang có vụ nuôi ở trạng thái lập kế hoạch hoặc đang hoạt động',
        CHANGE_CONFLICT: 'Trạng thái trang trại đã thay đổi. Vui lòng tải lại và thử lại',
    },

    POND: {
        LIST_FETCHED: 'Lấy danh sách ao thành công',
        FETCHED: 'Lấy chi tiết ao thành công',
        CREATED: 'Tạo ao thành công',
        UPDATED: 'Cập nhật ao thành công',
        DELETED: 'Xóa ao thành công',
        NOT_FOUND: 'Không tìm thấy ao',
        NAME_ALREADY_EXISTS: 'Tên ao đã tồn tại trong danh sách đang hoạt động của trang trại',
        HAS_OPEN_SEASON: 'Không thể xóa ao đang có vụ nuôi lập kế hoạch hoặc hoạt động',
        OPEN_SEASON_RESTRICTS_UPDATE: 'Vụ nuôi đang mở không cho phép thay đổi loại ao, ngừng hoạt động hoặc thay đổi thể tích',
        VOLUME_OUT_OF_RANGE: 'Thể tích tính từ diện tích và độ sâu vượt quá giới hạn cho phép',
        CHANGE_CONFLICT: 'Trạng thái ao đã thay đổi. Vui lòng tải lại và thử lại',
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
