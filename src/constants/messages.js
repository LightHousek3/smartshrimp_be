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
        ALL_MARKED_READ: 'Đã đánh dấu tất cả thông báo là đã đọc',
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
        VOLUME_EXCEEDS_CAPACITY: 'Thể tích không được vượt quá diện tích nhân với độ sâu của ao',
        CHANGE_CONFLICT: 'Trạng thái ao đã thay đổi. Vui lòng tải lại và thử lại',
    },

    SEASON: {
        LIST_FETCHED: 'Lấy danh sách vụ nuôi thành công',
        FETCHED: 'Lấy chi tiết vụ nuôi thành công',
        CREATED: 'Tạo vụ nuôi thành công',
        PERSONNEL_ASSIGNED: 'Phân công nhân sự vào vụ nuôi thành công',
        PERSONNEL_REPLACED: 'Thay nhân sự phụ trách vụ nuôi thành công',
        UPDATED: 'Cập nhật vụ nuôi thành công',
        ACTIVATED: 'Kích hoạt vụ nuôi thành công',
        CANCELLED: 'Hủy vụ nuôi thành công',
        NOT_FOUND: 'Không tìm thấy vụ nuôi',
        POND_NOT_FOUND: 'Không tìm thấy ao thuộc trang trại của bạn',
        INVALID_CURSOR: 'Không tìm thấy mốc phân trang vụ nuôi',
        FARM_ARCHIVED: 'Không thể tạo vụ nuôi trong trang trại đã lưu trữ',
        POND_ARCHIVED: 'Không thể tạo vụ nuôi trong ao đã lưu trữ',
        POND_NOT_AVAILABLE: 'Chỉ có thể tạo vụ nuôi trong ao đang sẵn sàng',
        POND_NOT_AQUACULTURE: 'Chỉ có thể tạo vụ nuôi trong ao nuôi thủy sản',
        OPEN_SEASON_EXISTS: 'Ao đã có một vụ nuôi đang lập kế hoạch hoặc hoạt động',
        PLANNING_UPDATE_ONLY: 'Chỉ có thể cập nhật vụ nuôi ở trạng thái lập kế hoạch',
        INVALID_DATE_RANGE: 'Ngày dự kiến kết thúc phải từ ngày thả giống trở đi',
        DERIVED_VALUE_OUT_OF_RANGE: 'Mật độ ban đầu vượt quá giới hạn cho phép',
        ACTIVATION_REQUIRES_PLANNING: 'Chỉ có thể kích hoạt vụ nuôi đang lập kế hoạch',
        ACTIVATION_CONDITIONS_NOT_MET: 'Vụ nuôi chưa đáp ứng đủ điều kiện kích hoạt',
        CANCELLATION_NOT_ALLOWED: 'Chỉ có thể hủy vụ nuôi đang lập kế hoạch hoặc đang hoạt động',
        ASSIGNMENT_NOT_ALLOWED:
            'Chỉ có thể phân công nhân sự cho vụ nuôi đang lập kế hoạch hoặc đang hoạt động',
        ASSIGNMENT_PERSONNEL_NOT_ELIGIBLE:
            'Không tìm thấy nhân sự đang hoạt động, đúng vai trò và thuộc quyền quản lý của bạn',
        ASSIGNMENT_ROLE_OCCUPIED:
            'Vai trò này đã có nhân sự phụ trách. Vui lòng sử dụng chức năng thay nhân sự',
        ASSIGNMENT_PERSONNEL_ALREADY_ASSIGNED:
            'Nhân sự này đã được phân công vào vụ nuôi',
        ASSIGNMENT_CONFLICT:
            'Phân công nhân sự đã thay đổi. Vui lòng tải lại và thử lại',
        REPLACEMENT_CURRENT_ASSIGNMENT_CHANGED:
            'Nhân sự phụ trách hiện tại đã thay đổi. Vui lòng tải lại và thử lại',
        REPLACEMENT_SAME_PERSONNEL:
            'Nhân sự thay thế phải khác nhân sự đang phụ trách',
        REPLACEMENT_CONFLICT:
            'Việc thay nhân sự bị xung đột. Vui lòng tải lại và thử lại',
        CHANGE_CONFLICT: 'Vụ nuôi đã thay đổi. Vui lòng tải lại và thử lại',
    },

    ASSIGNED_SEASON: {
        LIST_FETCHED: 'Lấy danh sách vụ nuôi được phân công thành công',
        FETCHED: 'Lấy chi tiết vụ nuôi được phân công thành công',
        NOT_FOUND: 'Không tìm thấy vụ nuôi được phân công',
        INVALID_CURSOR: 'Mốc phân trang vụ nuôi không hợp lệ',
    },

    WATER_LOG: {
        CREATED: 'Nhập nhật ký đo nước thành công',
        LIST_FETCHED: 'Lấy danh sách nhật ký đo nước thành công',
        STATISTICS_FETCHED: 'Lấy thống kê chất lượng nước thành công',
        NOT_FOUND: 'Không tìm thấy nhật ký đo nước',
        INVALID_CURSOR: 'Mốc phân trang nhật ký đo nước không hợp lệ',
        SEASON_NOT_ACTIVE: 'Chỉ được nhập nhật ký cho vụ nuôi đang hoạt động',
        NO_ASSIGNMENT: 'Bạn không được phân công phụ trách vụ nuôi này',
        ALREADY_VOIDED: 'Nhật ký này đã bị hủy hiệu lực',
        VOID_FORBIDDEN_STATE: 'Chỉ được hủy hiệu lực nhật ký của vụ nuôi đang hoạt động',
        VOIDED: 'Hủy hiệu lực nhật ký đo nước thành công',
        AT_LEAST_ONE_METRIC: 'Phải nhập ít nhất một chỉ số đo',
        DUPLICATE_LOG: 'Nhật ký đo nước cho thời điểm này đã tồn tại',
        IDEMPOTENCY_KEY_REUSED: 'Khóa lưu nhật ký đã được dùng cho nội dung khác',
        RECORDED_AT_TOO_FAR_FUTURE: 'Thời điểm đo không được vượt quá hiện tại 5 phút',
        INVALID_DATE_RANGE: 'Khoảng thời gian thống kê tối đa 90 ngày',
    },

    EXPERT_DASHBOARD: {
        FETCHED: 'Lấy tổng quan chuyên gia thành công',
    },

    EXPERT_SEASON: {
        LIST_FETCHED: 'Lấy danh sách vụ nuôi được phân công thành công',
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

    // Operation
    OPERATION: {
        LIST_FETCHED: 'Lấy danh sách kế hoạch vận hành thành công',
        FETCHED: 'Lấy chi tiết kế hoạch vận hành thành công',
        EXECUTED: 'Ghi nhận thực hiện hoạt động thành công',
        STATS_FETCHED: 'Lấy thống kê vận hành thành công',
        NOT_FOUND: 'Không tìm thấy lịch vận hành',
        SCHEDULE_NOT_PLANNED: 'Lịch vận hành không ở trạng thái chờ thực hiện',
        SEASON_NOT_ACTIVE: 'Vụ nuôi không ở trạng thái đang hoạt động',
        NOT_ASSIGNED_TECHNICIAN: 'Bạn không phải là kỹ thuật viên phụ trách vụ nuôi này',
        INSUFFICIENT_INVENTORY: 'Số lượng vật tư trong kho không đủ để thực hiện',
        VARIANCE_REASON_REQUIRED: 'Cần cung cấp lý do khi số lượng chênh lệch vượt mức cho phép',
        INVALID_ACTUAL_QUANTITY: 'Số lượng thực tế phải lớn hơn 0',
        INVALID_IDEMPOTENCY_KEY: 'Mã idempotency_key không hợp lệ',
    },

    // Server
    SERVER: {
        INTERNAL_ERROR: 'Lỗi máy chủ nội bộ',
        SERVICE_UNAVAILABLE: 'Dịch vụ tạm thời không khả dụng',
        TOO_MANY_REQUESTS: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
    },
};

module.exports = messages;
