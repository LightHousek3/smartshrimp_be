/**
 * Centralized message constants
 */
const messages = {
    AI_DIAGNOSIS: {
        CREATED: 'Đã xử lý yêu cầu nhận diện.',
        LOW_CONFIDENCE:
            'Vui lòng cung cấp lại ảnh tôm rõ nét, đủ sáng và thấy rõ vùng nghi bệnh để hỗ trợ nhận diện, hoặc liên hệ Chuyên gia để kiểm tra.',
        LIST_FETCHED: 'Lấy lịch sử nhận diện thành công.',
        DETAIL_FETCHED: 'Lấy chi tiết nhận diện thành công.',
        NOT_FOUND: 'Không tìm thấy kết quả nhận diện.',
        SEASON_NOT_FOUND: 'Không tìm thấy vụ nuôi.',
        ASSIGNMENT_REQUIRED: 'Bạn không còn được phân công kỹ thuật viên cho vụ nuôi này.',
        ACTIVE_SEASON_REQUIRED: 'Chỉ được yêu cầu nhận diện trong vụ nuôi đang hoạt động.',
        ACCOUNT_UNAVAILABLE: 'Tài khoản kỹ thuật viên không còn hoạt động.',
        INVALID_IMAGES: 'Cần gửi từ 1 đến 5 ảnh JPEG, PNG hoặc WEBP, mỗi ảnh không quá 10 MiB.',
        INVALID_MULTIPART:
            'Yêu cầu phải là multipart/form-data, chỉ chứa các file trong trường images.',
        INVALID_CURSOR: 'Con trỏ phân trang không hợp lệ.',
        BUSY: 'Hệ thống đang xử lý ảnh. Vui lòng thử lại sau.',
        UNAVAILABLE: 'Dịch vụ nhận diện chưa sẵn sàng. Vui lòng thử lại sau.',
        TIMEOUT:
            'Dịch vụ nhận diện phản hồi quá thời gian chờ. Vui lòng kiểm tra lịch sử trước khi gửi lại.',
        INVALID_RESPONSE: 'Dịch vụ nhận diện trả kết quả không hợp lệ.',
        IMAGE_REJECTED:
            'Ảnh không đáp ứng yêu cầu nhận diện. Hãy chọn ảnh tôm rõ nét, tối thiểu 224 × 224 pixel.',
        RATE_LIMITED: 'Đã vượt giới hạn yêu cầu nhận diện. Vui lòng thử lại sau.',
        STORAGE_UNAVAILABLE: 'Chưa thể lưu hoặc mở ảnh nhận diện. Vui lòng thử lại sau.',
        CONFLICT: 'Phân công hoặc trạng thái vụ nuôi vừa thay đổi. Vui lòng tải lại.',
    },
    INVENTORY_LABEL: {
        SCANNED: 'Đã đọc nhãn. Vui lòng đối chiếu trước khi sử dụng.',
        INVALID_IMAGE_TYPE: 'OCR chỉ nhận ảnh JPG, PNG hoặc WebP hợp lệ.',
        INVALID_IMAGE_SOURCE:
            'Ảnh đã lưu phải thuộc Cloudinary của ứng dụng. Hãy chọn lại ảnh từ thiết bị.',
        IMAGE_DOWNLOAD_FAILED: 'Không tải được ảnh nhãn đã lưu. Hãy chọn lại ảnh từ thiết bị.',
        INVALID_IMAGE_SIZE: 'Mỗi ảnh OCR phải có dung lượng từ 1 byte đến 5 MB.',
        INCOMPLETE_RESULT: 'AI chưa đọc được nhãn đầy đủ. Hãy chụp rõ phần chữ hoặc nhập tay.',
        INVALID_RESULT: 'Kết quả đọc nhãn không hợp lệ. Hãy thử lại hoặc nhập tay.',
        NO_EVIDENCE: 'Không đọc được thông tin có bằng chứng. Hãy chụp rõ nhãn hoặc nhập tay.',
        TOTAL_SIZE_EXCEEDED:
            'Tổng ảnh OCR không được vượt quá 5 MB. Hãy chọn ít ảnh hơn hoặc giảm dung lượng.',
        DAILY_LIMIT:
            'Đã hết hạn mức OCR trong ngày của ứng dụng. Bạn có thể nhập tay hoặc thử lại ngày mai.',
        PROVIDER_QUOTA:
            'Gemini đã hết quota hoặc đang giới hạn lượt gọi. Hãy nhập tay và thử lại sau; không cần bấm quét liên tục.',
        INVALID_CONFIG:
            'OCR chưa sử dụng được API key hoặc model đã cấu hình. Vui lòng kiểm tra cấu hình Gemini ở backend.',
        TIMEOUT: 'Đọc nhãn quá thời gian chờ. Bạn có thể thử lại hoặc nhập tay.',
        PROVIDER_UNAVAILABLE:
            'Dịch vụ đọc nhãn đang gián đoạn. Vui lòng thử lại sau hoặc nhập tay.',
        MISSING_KEY:
            'Chưa cấu hình OCR_GEMINI_API_KEY ở backend. Bạn vẫn có thể nhập thông tin nhãn bằng tay.',
        COOLDOWN: 'Gemini đang giới hạn lượt gọi. Vui lòng chờ một phút hoặc nhập tay.',
        BUSY: 'OCR đang bận. Vui lòng thử lại sau hoặc nhập tay.',
        RATE_LIMIT: 'Bạn đã quét nhãn quá nhiều lần. Vui lòng chờ một phút hoặc nhập tay.',
    },
    INVENTORY_SUBSTANCE: {
        FETCHED: 'Danh mục thành phần theo tài liệu đã đối chiếu.',
    },
    EXPERT_PROTOCOL_TEMPLATE: {
        SPECIES_REQUIRED: 'Phác đồ mẫu phải chỉ định tôm thẻ chân trắng hoặc tôm sú.',
        INVALID_APPLICATION_DAYS:
            'Ngày áp dụng vật tư phải tăng dần, không trùng và nằm trong giai đoạn.',
        MATERIAL_LIST_FETCHED: 'Lấy danh sách vật tư thành công.',
        CREATED: 'Tạo phác đồ mẫu thành công.',
        UPDATED: 'Cập nhật phác đồ mẫu thành công.',
        MATERIAL_UNAVAILABLE: 'Vật tư không khả dụng',
        FARM_NOT_FOUND: 'Không tìm thấy trang trại trong phạm vi quản lý.',
        DELETED_FARM: 'Trang trại đã xóa',
        EXPERT_ASSIGNMENT_CHANGED: 'Phân công hoặc trạng thái tài khoản đã thay đổi.',
        WRITE_CONFLICT: 'Dữ liệu vừa thay đổi hoặc đã có tham chiếu. Hãy tải lại trước khi lưu.',
        EXPERT_UNASSIGNED: 'Chuyên gia chưa được phân công chủ trại.',
        REFERENCE_POST_COUNT_REQUIRED: 'Phải nhập số PL tham chiếu khi cấu hình thức ăn tăng đều.',
        STALE_SAVE: 'Mẫu đã thay đổi. Hãy tải lại trước khi lưu.',
        REFERENCED_FARM_LOCKED: 'Không thể đổi trang trại của mẫu đã được tham chiếu.',
        MATERIAL_UNAVAILABLE_OR_FOREIGN: 'Vật tư không khả dụng hoặc không thuộc trang trại.',
        MANUFACTURER_UNAVAILABLE_OR_FOREIGN:
            'Nhà sản xuất không khả dụng hoặc ngoài phạm vi Owner.',
        STALE_DELETE: 'Mẫu đã thay đổi. Hãy tải lại trước khi xóa.',
        REFERENCED_DELETE_BLOCKED: 'Mẫu đã được tham chiếu. Hãy chuyển trạng thái ngừng sử dụng.',
        DELETE_CONFLICT: 'Mẫu vừa thay đổi hoặc đã được tham chiếu.',
        OPERATION_REQUIRED: 'Phải chọn loại hoạt động của hạng mục.',
        INVALID_DOSE: 'Liều mỗi lần phải lớn hơn 0 và không vượt giới hạn lưu trữ.',
        INVALID_DAILY_INCREMENT: 'Tăng đều chỉ dùng cho thức ăn liều cố định trong DOC 1–29.',
        FINAL_DOSE_EXCEEDED: 'Liều cuối giai đoạn vượt giới hạn.',
        INCOMPATIBLE_OPERATION_ROUTE:
            'Loại hoạt động không phù hợp với cữ ăn hoặc xử lý môi trường.',
        DOC_DOSING_RULE:
            'DOC 1–29 dùng liều cữ cố định; theo sinh khối từ DOC 30. Xử lý nước dùng cố định hoặc theo m³.',
        INCOMPATIBLE_DOSE_UNIT:
            'Đơn vị liều không tương thích quy cách vật tư hoặc tỷ lệ sinh khối không hợp lệ.',
        INVALID_STAGE: 'Giai đoạn phải theo thứ tự, không chồng lấn và có ít nhất một hoạt động.',
        INVALID_ENVIRONMENT_START_DOC: 'DOC bắt đầu xử lý môi trường phải nằm trong giai đoạn.',
        INVALID_ENVIRONMENT_INTERVAL:
            'Chu kỳ lặp không được vượt số ngày còn lại từ DOC bắt đầu xử lý đến cuối giai đoạn.',
        INVALID_MEAL_START_DOC: 'DOC bắt đầu vật tư trong cữ phải nằm trong giai đoạn.',
        DUPLICATE_MEAL_MATERIAL: 'Không được thêm cùng vật tư hai lần trong một cữ.',
        ORDERED_MEAL_TIMES: 'Giờ các cữ phải theo thứ tự trong ngày.',
        ITEM_LIMIT: 'Một mẫu có tối đa 500 hạng mục.',
        LIST_FETCHED: 'Lấy danh sách phác đồ nuôi mẫu thành công',
        FETCHED: 'Lấy chi tiết phác đồ nuôi mẫu thành công',
        NOT_FOUND: 'Không tìm thấy phác đồ nuôi mẫu',
    },

    MATERIAL_COMPLIANCE: {
        PROPOSAL_REASON_REQUIRED: 'lý do đề xuất',
        DETECTED_SUBSTANCES: (names) => `Phát hiện chất cấm: ${names} trong sản phẩm.`,
        NEGATED_SUBSTANCES: (names) => `Tên chất cần đối chiếu trong câu phủ định: ${names}.`,
        PROHIBITED_WARNING: 'Phát hiện chất cấm trong sản phẩm.',
        PROHIBITED_REVIEW_REQUIRED:
            'Nội dung nhắc đến chất cấm trong câu phủ định. Cần đối chiếu nhãn và làm rõ thành phần trước khi sử dụng.',
        NO_PROHIBITED_MATCH:
            'Chưa phát hiện tên chất cấm trong nội dung đã nhập theo Phụ lục I. Hãy kiểm tra đủ thành phần trên nhãn.',
        REGULATORY_TYPE_REQUIRED: 'phân loại pháp lý',
        REGISTRATION_REQUIRED: 'mã tiếp nhận/số ĐKLH',
        INGREDIENTS_REQUIRED: 'thành phần',
        LABEL_USAGE_REQUIRED: 'hướng dẫn theo nhãn',
        EVIDENCE_REQUIRED: 'ảnh/nguồn hồ sơ',
        ANTIBIOTIC_CLASSIFICATION_REQUIRED: 'xác định kháng sinh',
        REGISTRATION_FORMAT: (prefix) =>
            `Mã số tiếp nhận phải có dạng ${prefix}XXXXXX (6 chữ số từ 000001 đến 999999), ví dụ ${prefix}123456. Nhập đúng mã trên nhãn/hồ sơ sản phẩm.`,
        MEDICINE_REGISTRATION_FORMAT:
            'Nhập nguyên số đăng ký lưu hành thuốc thú y trên nhãn/hồ sơ, tối đa 100 ký tự; không dùng mã tiếp nhận 01-/02-/03- của thức ăn hoặc sản phẩm môi trường.',
        ANTIBIOTIC_REQUIRES_MEDICINE: 'kháng sinh chỉ thuộc hồ sơ thuốc',
        WITHDRAWAL_REQUIRED: 'thời gian ngừng thuốc',
        ANTIBIOTIC_TREATMENT_ONLY:
            'Vật tư chứa kháng sinh cần phác đồ điều trị gắn ca bệnh. Anh/chị chọn vật tư khác cho phác đồ mẫu.',
        DRAFT_PLAN_ONLY:
            'Anh/chị bổ sung nhãn và hồ sơ còn thiếu để đối chiếu trước khi áp dụng phác đồ cho vụ nuôi.',
        PROFILE_INCOMPLETE: 'Hồ sơ chưa đủ điều kiện sử dụng.',
        MANUFACTURER_UNVERIFIED: (productName) => `${productName}: chưa đối chiếu nhà sản xuất.`,
        INCOMPATIBLE_LEGAL_USE: (productName) =>
            `${productName}: mục đích sử dụng không phù hợp hồ sơ pháp lý.`,
        MANUFACTURER_REQUIRED: 'Phải xác định nhà sản xuất trước khi lưu hồ sơ vật tư.',
        MISSING_PROPOSAL_FIELDS: (missingFields) => `Hồ sơ đề xuất thiếu: ${missingFields}.`,
    },

    ACCOUNT: {
        LIST_FETCHED: 'Lấy danh sách tài khoản thành công',
        FETCHED: 'Lấy thông tin tài khoản thành công',
        CREATED: 'Tạo tài khoản thành công',
        NOT_FOUND: 'Không tìm thấy tài khoản',
        EMAIL_ALREADY_EXISTS: 'Email này đã được sử dụng',
        INVALID_MANAGING_OWNER: 'Chủ quản phải là tài khoản Chủ trang trại',
        OWNER_NOT_ACTIVE: 'Chủ quản phải đang hoạt động',
        ACTIVATION_EMAIL_SENT: 'Đã gửi lời mời kích hoạt tài khoản',
        ACTIVATION_NOT_PENDING: 'Chỉ tài khoản chờ kích hoạt mới có thể nhận lời mời',
        ACTIVATION_EMAIL_FAILED: 'Không thể gửi lời mời kích hoạt. Vui lòng thử lại sau',
        STATUS_UPDATED: 'Cập nhật trạng thái tài khoản thành công',
        STATUS_UNCHANGED: 'Trạng thái mới phải khác trạng thái hiện tại',
        STATUS_PENDING_PROTECTED: 'Tài khoản chờ kích hoạt phải được xác minh qua email',
        ADMIN_STATUS_PROTECTED: 'Không thể thay đổi trạng thái tài khoản Admin tại đây',
        STAFF_HAS_ACTIVE_ASSIGNMENT:
            'Cần thay thế nhân sự đang được phân công trước khi vô hiệu hóa',
        OWNER_HAS_ACTIVE_STAFF: 'Cần vô hiệu hóa hoặc chuyển nhân sự của chủ trại trước',
        OWNER_HAS_OPEN_SEASON: 'Không thể vô hiệu hóa chủ trại đang có vụ nuôi mở',
        ONLY_PENDING_UPDATABLE: 'Chỉ có thể chỉnh sửa email của tài khoản chờ kích hoạt',
        PENDING_UPDATE_SUCCESS: 'Đã cập nhật email và gửi lại lời mời kích hoạt',
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
        TOKEN_REFRESHED: 'Gia hạn phiên đăng nhập thành công',
        PENDING_ACTIVATION: 'Tài khoản chưa được kích hoạt. Vui lòng kích hoạt trước',
        ACCOUNT_BLOCKED: 'Tài khoản của bạn đã bị khóa. Vui lòng liên hệ bộ phận hỗ trợ',
        ACCOUNT_INACTIVE: 'Tài khoản đang tạm ngừng sử dụng. Vui lòng liên hệ bộ phận hỗ trợ',
        INVALID_CREDENTIALS: 'Email hoặc mật khẩu không chính xác',
        LOGIN_CONFLICT: 'Thông tin tài khoản đã thay đổi trong lúc đăng nhập. Vui lòng thử lại.',
        INVALID_REFRESH_TOKEN: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn',
        ACCESS_TOKEN_EXPIRED: 'Phiên truy cập đã hết hạn. Vui lòng đăng nhập lại',
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
        ACCOUNT_ALREADY_ACTIVATED: 'Tài khoản đã được kích hoạt. Vui lòng đăng nhập.',
        VERIFICATION_CONFLICT: 'Yêu cầu xác thực đang được xử lý. Vui lòng thử lại',
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
        GEOCODE_FETCHED: 'Tra cứu vị trí trang trại thành công',
        GEOCODE_UNAVAILABLE: 'Dịch vụ bản đồ đang bận. Vui lòng thử lại sau.',
        GEOCODE_NOT_CONFIGURED: 'Dịch vụ bản đồ chưa được cấu hình.',
        LIST_FETCHED: 'Lấy danh sách trang trại thành công',
        FETCHED: 'Lấy chi tiết trang trại thành công',
        CREATED: 'Tạo trang trại thành công',
        UPDATED: 'Cập nhật trang trại thành công',
        DELETED: 'Xóa trang trại thành công',
        NOT_FOUND: 'Không tìm thấy trang trại',
        NAME_ALREADY_EXISTS: 'Tên trang trại đã tồn tại trong danh sách của bạn',
        OWNER_NOT_ELIGIBLE: 'Chỉ chủ trang trại đang hoạt động mới có thể tạo trang trại',
        CANNOT_DEACTIVATE_WITH_OPEN_SEASONS:
            'Không thể ngừng hoạt động trang trại khi còn vụ nuôi đang lập kế hoạch hoặc hoạt động',
        HAS_REFERENCES: 'Chỉ có thể xóa trang trại khi không còn ao, vật tư hoặc nhiệm vụ',
        TEMPORARILY_UNAVAILABLE: 'Chức năng trang trại đang được cập nhật. Vui lòng thử lại sau.',
        TEMPLATE_INACTIVATED_TITLE: 'Phác đồ mẫu ngừng sử dụng',
        templateInactivatedContent: (farmName, templateTitle) =>
            `Phác đồ mẫu đã ngừng sử dụng vì trang trại “${farmName}” bị xóa: “${templateTitle}”.`,
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
        HAS_REFERENCES: 'Không thể xóa ao còn dữ liệu liên quan hoặc lịch sử vụ nuôi',
        OPEN_SEASON_RESTRICTS_UPDATE:
            'Vụ nuôi đang mở không cho phép thay đổi loại ao hoặc chuyển sang bảo trì',
        VOLUME_OUT_OF_RANGE: 'Thể tích tính từ diện tích và độ sâu vượt quá giới hạn cho phép',
        VOLUME_EXCEEDS_CAPACITY: 'Thể tích không được vượt quá diện tích nhân với độ sâu của ao',
        DIMENSIONS_IMMUTABLE:
            'Không được cập nhật diện tích và độ sâu của ao; chỉ được cập nhật thể tích',
        CHANGE_CONFLICT: 'Trạng thái ao đã thay đổi. Vui lòng tải lại và thử lại',
    },

    SUPPLIER: {
        IDENTITY_LOCKED:
            'Nhà cung cấp đã có tham chiếu nghiệp vụ. Không thể đổi tên hoặc vai trò cung ứng',
        NOT_SELECTABLE: 'Chọn đối tác đang hoạt động, đúng vai trò và thuộc danh bạ của bạn',
        HAS_REFERENCES: 'Nhà cung cấp đã có tham chiếu. Hãy chuyển sang tạm ngưng thay vì xóa',
        MANUFACTURER_REFERENCED:
            'Không thể bỏ vai trò nhà sản xuất khi đã được vật tư hoặc đề xuất tham chiếu',
        LIST_FETCHED: 'Lấy danh sách nhà cung cấp thành công',
        FETCHED: 'Lấy thông tin nhà cung cấp thành công',
        CREATED: 'Thêm nhà cung cấp thành công',
        UPDATED: 'Cập nhật nhà cung cấp thành công',
        NOT_FOUND: 'Không tìm thấy nhà cung cấp đang hoạt động của trang trại',
        NAME_EXISTS: 'Tên nhà cung cấp đã tồn tại trong trang trại',
        CHANGE_CONFLICT: 'Nhà cung cấp đã thay đổi. Vui lòng tải lại và thử lại',
    },

    INVENTORY: {
        MATERIAL_SELECTION_CHANGED: (name) =>
            `Vật tư ${name ? `"${name}" ` : ''}đã thay đổi hoặc không còn khả dụng. Vui lòng xem lại và chọn lại vật tư trước khi lưu hoặc gửi duyệt.`,
        MATERIAL_UPDATED_TITLE: 'Vật tư trong phác đồ đã thay đổi',
        MATERIAL_UPDATED_CONTENT: (name) =>
            `Thông tin vật tư "${name}" đã được cập nhật. Vui lòng xem lại và chọn lại vật tư trong phác đồ nháp hoặc mẫu liên quan.`,
        MATERIAL_INACTIVE_TITLE: 'Vật tư trong phác đồ đã ngừng sử dụng',
        MATERIAL_INACTIVE_CONTENT: (name) =>
            `Vật tư "${name}" đã ngừng sử dụng. Vui lòng điều chỉnh vật tư trong phác đồ hoặc mẫu liên quan.`,
        INCOMPLETE_PRODUCT:
            'Vui lòng nhập đầy đủ nhà sản xuất, loại sản phẩm, mã số tiếp nhận, thành phần, hướng dẫn sử dụng, kháng sinh và thời gian ngừng trước khi sử dụng vật tư',
        READ_ONLY: 'Kho hiện chỉ hỗ trợ xem dữ liệu. Cần đồng bộ dữ liệu kho trước khi cập nhật.',
        CONVERSION_REQUIRED: 'PACK và BOTTLE bắt buộc phải có số lượng và đơn vị quy đổi',
        CONVERSION_NOT_ALLOWED: 'Thông tin quy đổi chỉ áp dụng cho PACK và BOTTLE',
        BOTTLE_CONVERSION_UNIT: 'Đơn vị chai chỉ được quy đổi sang lít hoặc ml.',
        EXPIRY_IN_PAST: 'Hạn sử dụng không được trong quá khứ',
        INVALID_EXECUTION_QUANTITY: 'Số lượng thực dùng không hợp lệ',
        INCOMPATIBLE_EXECUTION_UNIT:
            'Đơn vị thực dùng không quy đổi được sang đơn vị kho của vật tư',
        INVALID_CONVERSION: 'Vật tư chưa có quy cách quy đổi hợp lệ',
        CONVERTED_QUANTITY_LIMIT: 'Lượng quy đổi vượt giới hạn độ chính xác của kho',
        DELETED: 'Xóa vật tư chưa có phát sinh thành công',
        HAS_REFERENCES:
            'Không thể xóa vật tư đã có phát sinh kho, lịch vận hành hoặc phác đồ không còn ở trạng thái nháp',
        DELETE_CONFIRMATION: (name, templates, protocols) =>
            `Vật tư "${name}" đang được dùng trong ${[templates.length && `mẫu phác đồ: ${templates.join(', ')}`, protocols.length && `phác đồ nháp: ${protocols.join(', ')}`].filter(Boolean).join('; ')}. Xóa sẽ gỡ liên kết vật tư và tạm ngưng các mẫu bị ảnh hưởng. Bạn cần cập nhật vật tư thay thế trước khi sử dụng lại. Bạn có xác nhận xóa không?`,
        DELETED_MATERIAL_REPLACEMENT:
            'Vật tư đã bị xóa. Vui lòng cập nhật vật tư thay thế trong phác đồ.',
        DELETED_NOTIFICATION_TITLE: 'Vật tư đã bị xóa',
        DELETED_NOTIFICATION_CONTENT: (name, templates, protocols) =>
            `Đã xóa vật tư "${name}".${templates.length ? ` Vui lòng cập nhật vật tư thay thế trong các mẫu phác đồ đã tạm ngưng: ${templates.join(', ')}.` : ''}${protocols.length ? ` Vui lòng cập nhật các phác đồ nháp: ${protocols.join(', ')}.` : ''}`,
        METADATA_LOCKED:
            'Vật tư đã có lịch sử kho, vận hành hoặc phác đồ gửi duyệt. Hồ sơ được khóa, chỉ được sửa ngưỡng cảnh báo tồn kho',
        LOT_EXPIRY_CONFLICT: 'Các lần nhập cùng vật tư và số lô phải có cùng hạn sử dụng',
        LOT_EXPIRY_LOCKED:
            'Lô đã được dùng. Cần đối chiếu chuyên môn, không tự thay đổi bằng chứng hạn dùng',
        SUPPLIER_NAME_REQUIRED: 'Vui lòng chọn nhà cung cấp trong danh bạ của chủ trại',
        PRODUCT_BLOCKED: 'Sản phẩm đang bị chặn, không được sử dụng trong phác đồ.',
        IMAGE_FIELDS_CONFLICT: 'Chỉ cung cấp imageUrl hoặc imageUrls trong một yêu cầu',
        LABEL_IMAGE_REQUIRED: 'Mỗi vật tư phải có ít nhất 1 ảnh nhãn và tối đa 3 ảnh',
        PRODUCT_ARCHIVE_REASON: (name) => `Ngừng sử dụng vật tư ${name}`,
        SCHEDULES_CANCELLED_TITLE: 'Lịch vận hành đã bị hủy do ngừng vật tư',
        SCHEDULES_CANCELLED_CONTENT: (name, count) =>
            `${count} lịch chưa thực hiện đã bị hủy do ngừng sử dụng vật tư ${name}.`,
        LIST_FETCHED: 'Lấy danh sách vật tư và tồn kho thành công',
        FETCHED: 'Lấy chi tiết vật tư thành công',
        CREATED: 'Tạo vật tư thành công',
        UPDATED: 'Cập nhật vật tư thành công',
        ARCHIVED: 'Tạm ngưng vật tư thành công',
        RESTORED: 'Đã chuyển vật tư sang đang sử dụng',
        TRANSACTION_RECORDED: 'Ghi nhận biến động kho thành công',
        HISTORY_FETCHED: 'Lấy lịch sử biến động kho thành công',
        FARM_NOT_FOUND: 'Không tìm thấy trang trại thuộc quyền quản lý của bạn',
        PRODUCT_NOT_FOUND: 'Không tìm thấy vật tư',
        BALANCE_NOT_FOUND: 'Không tìm thấy lô tồn kho',
        NAME_UNIT_ALREADY_EXISTS: 'Tên vật tư và đơn vị này đã tồn tại trong kho',
        LOT_ALREADY_EXISTS: 'Mã lô này đã tồn tại cho vật tư',
        STOCK_REMAINS: 'Không thể lưu trữ vật tư khi kho vẫn còn tồn',
        DELETE_STOCK_REMAINS: 'Không thể xóa vật tư khi kho vẫn còn tồn',
        DELETE_PLANNED_USE_EXISTS:
            'Không thể xóa vật tư đang được dùng trong lịch vận hành dự kiến',
        PLANNED_USE_EXISTS: 'Không thể lưu trữ vật tư đang được dùng trong lịch vận hành dự kiến',
        PRODUCT_ARCHIVED: 'Vật tư đã được lưu trữ',
        PRODUCT_NOT_ARCHIVED: 'Vật tư chưa được lưu trữ',
        UNIT_LOCKED: 'Không thể thay đổi đơn vị hoặc quy đổi sau khi vật tư đã có giao dịch kho',
        INSUFFICIENT_STOCK: 'Số lượng xuất hoặc điều chỉnh vượt quá tồn kho hiện tại của lô',
        BALANCE_LIMIT_EXCEEDED: 'Số lượng tồn của lô vượt quá giới hạn cho phép',
        AMOUNT_LIMIT_EXCEEDED: 'Giá trị giao dịch vượt quá giới hạn cho phép',
        ADJUSTMENT_REASON_REQUIRED: 'Điều chỉnh tồn kho bắt buộc phải có lý do',
        IDEMPOTENCY_KEY_REQUIRED: 'Header Idempotency-Key là bắt buộc và phải là UUID hợp lệ',
        IDEMPOTENCY_KEY_CONFLICT: 'Idempotency-Key đã được sử dụng cho một giao dịch khác',
        INVALID_CURSOR: 'Không tìm thấy mốc phân trang lịch sử kho',
        INVALID_REFERENCE: 'referenceType và referenceId phải được cung cấp cùng nhau',
        CHANGE_CONFLICT: 'Dữ liệu kho đã thay đổi. Vui lòng tải lại và thử lại',
        LOW_STOCK_TITLE: 'Vật tư sắp hết',
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
        FARM_NOT_ACTIVE: 'Không thể tạo hoặc kích hoạt vụ nuôi trong trang trại không hoạt động',
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
        ASSIGNMENT_PERSONNEL_ALREADY_ASSIGNED: 'Nhân sự này đã được phân công vào vụ nuôi',
        ASSIGNMENT_CONFLICT: 'Phân công nhân sự đã thay đổi. Vui lòng tải lại và thử lại',
        REPLACEMENT_CURRENT_ASSIGNMENT_CHANGED:
            'Nhân sự phụ trách hiện tại đã thay đổi. Vui lòng tải lại và thử lại',
        REPLACEMENT_SAME_PERSONNEL: 'Nhân sự thay thế phải khác nhân sự đang phụ trách',
        REPLACEMENT_CONFLICT: 'Việc thay nhân sự bị xung đột. Vui lòng tải lại và thử lại',
        CHANGE_CONFLICT: 'Vụ nuôi đã thay đổi. Vui lòng tải lại và thử lại',
    },

    TASK: {
        LIST_FETCHED: 'Tải danh sách nhiệm vụ thành công.',
        CREATED: 'Tạo và giao nhiệm vụ thành công.',
        UPDATED: 'Cập nhật nhiệm vụ thành công.',
        CANCELLED: 'Hủy nhiệm vụ thành công.',
        STARTED: 'Đã bắt đầu nhiệm vụ và ghi nhận thời gian.',
        COMPLETED: 'Đã hoàn thành nhiệm vụ và ghi nhận thời gian.',
        INVALID_TRANSITION:
            'Trạng thái nhiệm vụ đã thay đổi hoặc không cho phép thao tác này. Vui lòng tải lại.',
        COMPLETED_NOTIFICATION: 'Kỹ thuật viên đã hoàn thành nhiệm vụ.',
        INVALID_EVIDENCE: 'Chọn tối đa 5 ảnh minh chứng.',
        EVIDENCE_ON_COMPLETION_ONLY: 'Chỉ được gửi ảnh minh chứng khi hoàn thành nhiệm vụ.',
        NOT_FOUND: 'Không tìm thấy nhiệm vụ.',
        TERMINAL: 'Nhiệm vụ đã hoàn thành hoặc đã hủy, không thể thay đổi.',
        CONFLICT: 'Nhiệm vụ hoặc phân công đã thay đổi. Vui lòng tải lại.',
        LOCKED_FIELDS: 'Nhiệm vụ đang làm chỉ được sửa mô tả, ưu tiên và hạn hoàn thành.',
        INVALID_FARM: 'Trang trại không tồn tại, không hoạt động hoặc không thuộc quyền quản lý.',
        INVALID_SEASON: 'Vụ nuôi không hợp lệ hoặc không thuộc trang trại đã chọn.',
        INVALID_ASSIGNEE: 'Kỹ thuật viên phải đang hoạt động và thuộc quyền quản lý của bạn.',
        NO_TECHNICIAN: 'Vụ nuôi chưa có kỹ thuật viên đang phụ trách hợp lệ.',
        INVALID_DEADLINE: 'Hạn hoàn thành phải lớn hơn thời gian hiện tại 10 phút.',
        ASSIGNED_NOTIFICATION: 'Bạn được giao nhiệm vụ mới.',
        CANCELLED_NOTIFICATION: (reason) => `Nhiệm vụ đã hủy. Lý do: ${reason}`,
        UPDATED_NOTIFICATION: (changes) => `Nhiệm vụ đã cập nhật: ${changes}`,
        FIELD_LABELS: {
            title: 'Tiêu đề',
            description: 'Mô tả',
            priority: 'Ưu tiên',
            dueAt: 'Hạn hoàn thành',
            farmId: 'Trang trại',
            seasonId: 'Vụ nuôi',
            assignedTo: 'Kỹ thuật viên',
        },
    },

    ASSIGNED_SEASON: {
        FARMS_FETCHED: 'Lấy danh sách trại có vụ nuôi được phân công thành công',
        LIST_FETCHED: 'Lấy danh sách vụ nuôi được phân công thành công',
        FETCHED: 'Lấy chi tiết vụ nuôi được phân công thành công',
        NOT_FOUND: 'Không tìm thấy vụ nuôi được phân công',
        INVALID_CURSOR: 'Mốc phân trang vụ nuôi không hợp lệ',
    },

    HARVEST: {
        NOTE_TOO_LONG: (limit) => `Ghi chú thu hoạch tối đa ${limit} ký tự.`,
        VARIANCE_REASON_REQUIRED:
            'Số thu thực tế và số còn lại vượt ước tính hiện có. Vui lòng nhập lý do hiệu chỉnh ước tính.',
        SCHEDULE_COMPLETED_REASON: 'Vụ nuôi đã hoàn tất thu hoạch cuối.',
        WITHDRAWAL_UNVERIFIED_WARNING:
            'Chưa đủ dữ liệu xác nhận thời gian ngừng thuốc. Vui lòng kiểm tra lịch sử dùng vật tư trước khi thu hoạch.',
        WITHDRAWAL_UNKNOWN:
            'Có lần dùng thuốc chưa xác định thời gian ngừng thuốc. Cần kiểm tra hồ sơ vật tư tại thời điểm thực dùng trước khi thu hoạch.',
        WITHDRAWAL_ACTIVE: 'Chưa đủ thời gian ngừng thuốc tại thời điểm thu hoạch đã chọn.',
        WITHDRAWAL_PRODUCT_NOT_READY:
            'Vật tư thực dùng chưa có hồ sơ đã đối chiếu hoặc chưa xác định thời gian ngừng thuốc.',
        WITHDRAWAL_EXECUTION_TIME:
            'Thời điểm dùng vật tư không hợp lệ hoặc vi phạm thời gian ngừng thuốc của lần thu hoạch đã ghi.',
        NOT_FOUND: 'Không tìm thấy lần thu hoạch hoặc vụ nuôi.',
        CONFLICT: 'Dữ liệu thu hoạch đã thay đổi. Vui lòng tải lại và thử lại.',
        INACTIVE: 'Chỉ ghi nhận thu hoạch cho vụ nuôi đang hoạt động.',
        INVALID_QUANTITY: 'Sản lượng hoặc số lượng thu hoạch không hợp lệ.',
        INVALID_TIME:
            'Thời điểm thu hoạch phải từ ngày thả giống, muộn hơn lần thu gần nhất và không ở tương lai.',
        INVALID_CURSOR: 'Con trỏ phân trang không hợp lệ.',
        KEY_CONFLICT: 'Khóa ghi nhận đã được sử dụng cho dữ liệu khác.',
        LIST: 'Đã tải danh sách thu hoạch.',
        DETAIL: 'Đã tải chi tiết thu hoạch.',
        CREATED: 'Đã ghi nhận thu hoạch.',
        INVALID_DATE_RANGE: 'from must not be after to',
        PARTIAL_COUNT_REQUIRED: 'Vui lòng nhập số con thu hoạch khi thu tỉa.',
        POPULATION_UNKNOWN:
            'Chưa xác định được số tôm hiện có. Vui lòng cập nhật số lượng trước khi thu tỉa.',
        PARTIAL_MISMATCH: (available, quantity, expected) =>
            `Số lượng thu tỉa không khớp: hiện có ${available} con, thu ${quantity} con thì phải còn ${expected} con. Vui lòng kiểm tra lại; hao hụt cần được ghi nhận riêng.`,
        PARTIAL_EXHAUSTED:
            'Thu tỉa phải còn tôm trong ao. Nếu thu hết, vui lòng chọn thu hoạch cuối.',
        EARLY_WARNING: (days, typicalDays) =>
            `Lưu ý: thu hoạch sau ${days} ngày nuôi, sớm hơn chu kỳ tham khảo ${typicalDays} ngày của loài. Owner cân nhắc theo tình trạng thực tế; bản ghi vẫn hợp lệ.`,
        RECORDED_TITLE: 'Đã ghi nhận thu tỉa',
        COMPLETED_TITLE: 'Vụ nuôi đã hoàn tất thu hoạch',
        RECORDED_CONTENT: (name, weight, isFinal) =>
            `Vụ nuôi ${name} đã ghi nhận ${isFinal ? 'thu hoạch cuối' : 'thu tỉa'} ${weight} kg.${isFinal ? ' Vụ nuôi đã hoàn tất.' : ''}`,
    },

    WATER_LOG: {
        METADATA_FETCHED: 'Lấy cấu hình chỉ số nước thành công',
        CREATED: 'Nhập nhật ký đo nước thành công',
        LIST_FETCHED: 'Lấy danh sách nhật ký đo nước thành công',
        STATISTICS_FETCHED: 'Lấy thống kê chất lượng nước thành công',
        NOT_FOUND: 'Không tìm thấy nhật ký đo nước',
        INVALID_CURSOR: 'Mốc phân trang nhật ký đo nước không hợp lệ',
        SEASON_NOT_ACTIVE: 'Chỉ được nhập nhật ký cho vụ nuôi đang hoạt động',
        CHANGE_CONFLICT: 'Vụ nuôi đã thay đổi. Vui lòng tải lại và thử lại',
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

    SHRIMP_HEALTH_LOG: {
        CREATED: 'Ghi nhận sức khỏe tôm thành công',
        LIST_FETCHED: 'Lấy danh sách nhật ký sức khỏe tôm thành công',
        DETAIL_FETCHED: 'Lấy chi tiết nhật ký sức khỏe tôm thành công',
        STATISTICS_FETCHED: 'Lấy thống kê sức khỏe và tăng trưởng thành công',
        NOT_FOUND: 'Không tìm thấy nhật ký sức khỏe tôm',
        INVALID_CURSOR: 'Mốc phân trang nhật ký sức khỏe tôm không hợp lệ',
        SEASON_NOT_ACTIVE: 'Chỉ được ghi nhận sức khỏe cho vụ nuôi đang hoạt động',
        NO_ASSIGNMENT: 'Bạn không được phân công phụ trách vụ nuôi này',
        ALREADY_VOIDED: 'Bản ghi sức khỏe này đã bị hủy hiệu lực',
        VOID_FORBIDDEN_STATE: 'Chỉ được hủy hiệu lực bản ghi của vụ nuôi đang hoạt động',
        VOID_ONLY_TODAY: 'Chỉ được hủy hiệu lực bản ghi sức khỏe tôm trong ngày hôm nay',
        VOIDED: 'Hủy hiệu lực bản ghi sức khỏe tôm thành công',
        VOID_REASON_REQUIRED: 'Lý do hủy bản ghi là bắt buộc',
        AT_LEAST_ONE_METRIC: 'Phải nhập ít nhất một chỉ số sức khỏe hoặc thể trạng tôm',
        ESTIMATED_POPULATION_EXCEEDS_INITIAL:
            'Số lượng tôm ước tính không được vượt quá số lượng giống thả ban đầu',
        DUPLICATE_LOG: 'Bản ghi sức khỏe tôm cho thời điểm này đã tồn tại',
        IDEMPOTENCY_KEY_REUSED: 'Khóa lưu bản ghi đã được dùng cho nội dung khác',
        RECORDED_AT_TOO_FAR_FUTURE: 'Thời điểm ghi nhận không được vượt quá hiện tại 5 phút',
        INVALID_DATE_RANGE: 'Khoảng thời gian thống kê không hợp lệ hoặc vượt quá 90 ngày',
    },

    EXPERT_DASHBOARD: {
        FETCHED: 'Lấy tổng quan chuyên gia thành công',
    },

    EXPERT_SEASON: {
        LIST_FETCHED: 'Lấy danh sách vụ nuôi được phân công thành công',
        METRICS_FETCHED: 'Lấy chỉ số chuyên môn vụ nuôi thành công',
        NOT_FOUND: 'Không tìm thấy vụ nuôi trong phạm vi được phân công.',
    },

    PROTOCOL: {
        FETCHED: 'Lấy dữ liệu phác đồ thành công.',
        REVIEWED: 'Đã lưu quyết định phác đồ.',
        NOT_FOUND: 'Không tìm thấy phác đồ trong phạm vi quản lý.',
        SEASON_NOT_FOUND: 'Không tìm thấy vụ nuôi trong phạm vi quản lý.',
        CONFLICT: 'Phác đồ hoặc vụ nuôi đã thay đổi. Vui lòng tải lại trước khi quyết định.',
        CLOSED: 'Không thể duyệt phác đồ khi vụ nuôi đã kết thúc hoặc trang trại không hoạt động.',
        INVALID_CASE: 'Ca bệnh không hợp lệ hoặc đã được giải quyết.',
        EMPTY: 'Phác đồ phải có ít nhất một hạng mục và giờ thực hiện hợp lệ.',
        PRODUCT: 'Vật tư đã liên kết phải đang hoạt động và thuộc cùng trang trại.',
        PREDECESSOR: 'Phiên bản thay thế không còn khớp với phác đồ đang có hiệu lực.',
        INVALID_DAY: 'Ngày nằm ngoài thời gian của phác đồ.',
    },

    PRODUCTION_PROTOCOL: {
        DRAFT_DELETED: 'Đã xóa bản nháp phác đồ.',
        DRAFT_DELETE_STATE:
            'Chỉ được xóa bản nháp chưa từng gửi duyệt; các bản đã gửi hoặc đã hủy được giữ trong lịch sử.',
        DUE_WINDOW_TOO_LARGE: 'Khoảng thực hiện quá lớn. Vui lòng nhập khoảng thời gian ngắn hơn.',
        DUE_WINDOW_INTEGER: 'Khoảng thực hiện phải là số phút nguyên.',
        DUE_WINDOW_INVALID: 'Khoảng thực hiện cần ít nhất 10 phút kể từ giờ dự kiến.',
        HARVEST_COVERAGE: (minimumDoc) =>
            `DOC kết thúc phác đồ nuôi phải lớn hơn hoặc bằng DOC ${minimumDoc} (ngày dự kiến thu hoạch của vụ nuôi).`,
        TEMPLATE_CHANGED:
            'Mẫu đã thay đổi hoặc chưa có phiên bản nguồn hợp lệ. Vui lòng nạp lại mẫu.',
        APPLICATION_DAYS:
            'Ngày áp dụng và mốc lặp phải nằm trong giai đoạn; không thay đổi mốc gốc khi chia lịch.',
        DAILY_INCREMENT:
            'Tăng liều chỉ dùng cho thức ăn liều cố định, mỗi ngày, trong DOC 1–29; liều cuối không được vượt giới hạn.',
        MATERIAL_UNRESOLVED:
            'Cần chọn vật tư catalog đủ điều kiện cho tất cả đề xuất trước khi phê duyệt.',
        MATERIAL_CHANGED:
            'Vật tư đã thay đổi nhà sản xuất, quy cách hoặc hồ sơ sau duyệt. Cần phác đồ được duyệt lại trước khi tạo hoặc thực thi lịch mới.',
        MATERIAL_LOCKED:
            'Lịch phải dùng đúng vật tư Chủ trang trại đã duyệt. Vui lòng yêu cầu duyệt lại phác đồ nếu cần đổi vật tư.',
        MATERIAL_RESOLUTION:
            'Vật tư thay thế phải thuộc cùng trang trại, đúng loại và tương thích đơn vị với đề xuất.',
        SCHEDULE_WAITING:
            'Lịch được tạo khi vụ đang hoạt động và có đủ dữ liệu. Nguồn sinh khối không quá 7 ngày (168 giờ) tại thời điểm dự kiến thực hiện.',
        SCHEDULE_BLOCKED: (reason) =>
            `Một phần lịch chưa thể tạo: ${reason}. Vui lòng bổ sung dữ liệu; hệ thống sẽ thử lại.`,
        SCHEDULE_BLOCKERS: {
            VOLUME_MISSING: 'thiếu thể tích ao hợp lệ',
            BASIS_OUT_OF_RANGE: 'sinh khối hoặc thể tích vượt giới hạn dữ liệu lịch',
            BIOMASS_MISSING_OR_STALE:
                'cữ cần nguồn sinh khối mới hoặc còn đại diện trong 7 ngày (168 giờ); KTV cần cân mẫu và cập nhật nhật ký sức khỏe',
            DOSE_INVALID: 'quy tắc liều không hợp lệ',
            QUANTITY_OUT_OF_RANGE: 'lượng vật tư vượt giới hạn hoặc quá nhỏ',
            MATERIAL_UNRESOLVED: 'vật tư chưa được xác nhận',
            MATERIAL_INELIGIBLE:
                'vật tư không còn đủ điều kiện hoặc hồ sơ đã đổi sau duyệt; cần kiểm tra và duyệt lại',
        },
        BIOMASS_WARNING:
            'Chưa có nguồn sinh khối hợp lệ trong 7 ngày (168 giờ). Nguồn phải còn hạn tại thời điểm dự kiến thực hiện từng cữ.',
        SCHEDULE_FAILED: 'Chưa thể tạo lịch phác đồ; hệ thống sẽ kiểm tra lại.',
        BIOMASS_SOURCE_INVALID:
            'Nguồn sinh khối của lịch không còn hợp lệ. Vui lòng kiểm tra nhật ký sức khỏe và yêu cầu lập lại lịch.',
        BIOMASS_SOURCE_VOIDED:
            'Đã hủy lịch phụ thuộc bản ghi sinh khối bị hủy. Lịch tương lai được tính lại khi có nguồn hợp lệ; không cần duyệt lại phác đồ nếu chỉ định không đổi.',
        SCHEMA_NOT_READY: 'Hệ thống chưa thể lưu phác đồ. Vui lòng liên hệ quản trị viên.',
        STORED_CONTENT_INVALID:
            'Nội dung phác đồ chưa đầy đủ hoặc không hợp lệ. Vui lòng kiểm tra các giai đoạn, cữ và liều lượng.',
        PENDING_NOTIFICATION_CONTENT: (title, versionNo, seasonName, pondName, farmName) =>
            `Phác đồ "${title}" (v${versionNo}) của vụ ${seasonName}, ao ${pondName}, trang trại ${farmName} đang chờ chủ trại duyệt.`,
        PENDING_NOTIFICATION_TITLE: 'Phác đồ đang chờ duyệt',
        STAGE_OVERLAP:
            'Các giai đoạn không được trùng ngày áp dụng. Ngày kết thúc cũng thuộc giai đoạn.',
        SUBMITTED: 'Đã gửi phác đồ để chủ trại duyệt.',
        SUBMIT_INCOMPLETE:
            'Cần có ít nhất một hạng mục và giờ thực hiện cho mọi cữ trước khi gửi duyệt.',
        TEMPLATE_NOT_FOUND: 'Không tìm thấy phác đồ mẫu phù hợp trong trang trại.',
        CREATED: 'Đã lưu bản nháp phác đồ.',
        UPDATED: 'Đã lưu phác đồ.',
        CANCELLED: 'Đã hủy hoặc thu hồi phác đồ chưa áp dụng.',
        EXPERT_INACTIVE: 'Tài khoản chuyên gia không còn hoạt động.',
        TIME_PRECISION:
            'Giờ thực hiện có độ chính xác cao hơn form hỗ trợ; không thể ghi lại các hạng mục này.',
        NOT_FOUND: 'Không tìm thấy vụ nuôi hoặc phác đồ trong phạm vi được phân công.',
        CONFLICT: 'Dữ liệu đã thay đổi. Vui lòng tải lại trước khi tiếp tục.',
        STATE: 'Trạng thái hiện tại không cho phép thao tác này.',
        IN_PROGRESS: 'Đã có bản đang soạn, bị từ chối hoặc chờ duyệt cần xử lý trước.',
        DEPENDENCY: 'Phác đồ đã có phiên bản kế tiếp hoặc lịch vận hành, không thể sửa/hủy.',
        PRODUCT: 'Vật tư phải đang hoạt động và thuộc cùng trang trại.',
        UNIT: 'Đơn vị liều không tương thích với đơn vị vật tư.',
        ID: 'ID giai đoạn, cữ hoặc hạng mục không thuộc phác đồ này.',
        DOSE: 'Cơ sở liều không hợp lệ cho tuổi nuôi của giai đoạn.',
    },

    RAG: {
        QUESTION_SAVED: 'Đã xử lý câu hỏi.',
        CONVERSATION_FETCHED: 'Đã tải hội thoại.',
        LIST_FETCHED: 'Đã tải danh sách hội thoại.',
        FEEDBACK_SAVED: 'Đã lưu đánh giá.',
        NOT_FOUND: 'Không tìm thấy hội thoại.',
        QUERY_NOT_FOUND: 'Không tìm thấy câu trả lời.',
        SEASON_REQUIRED: 'Hội thoại phải gắn với một vụ nuôi.',
        SEASON_MISMATCH: 'Không thể đổi vụ nuôi của hội thoại.',
        ASSIGNMENT_REQUIRED: 'Bạn cần phân công còn hiệu lực vào vụ nuôi này.',
        SEASON_CLOSED: 'Không thể gửi câu hỏi trong vụ nuôi đã hoàn tất hoặc đã hủy.',
        FORBIDDEN: 'Chỉ kỹ thuật viên đang hoạt động được sử dụng RAG.',
        NO_ANSWER: 'Chỉ được đánh giá câu trả lời đã được tạo.',
        UNAVAILABLE: 'Dịch vụ AI hiện không khả dụng. Vui lòng thử lại.',
        CONFLICT: 'Dữ liệu hoặc quyền truy cập đã thay đổi. Vui lòng thử lại.',
    },

    RAG_WARNINGS: {
        NO_SOURCE:
            'Chưa tìm thấy nguồn tham chiếu. Vui lòng kiểm chứng câu trả lời trước khi áp dụng.',
        LOW_MATCH:
            'Nguồn tham chiếu có độ liên quan thấp. Vui lòng kiểm chứng câu trả lời trước khi áp dụng.',
    },

    RAG_DOCUMENT: {
        CATEGORY_REQUIRED: 'Vui lòng chọn danh mục.',
        CREATED: 'Đã thêm tài liệu vào kho kiến thức chatbot.',
        NOT_FOUND: 'Không tìm thấy tài liệu.',
        RETRY_FAILED_ONLY: 'Chỉ thử lại tài liệu xử lý thất bại.',
        RETRY_CONFLICT: 'Tài liệu vừa thay đổi. Vui lòng làm mới.',
        FILE_REQUIRED: 'Vui lòng tải lên một tài liệu trong trường file.',
        INVALID_UPLOAD: 'Chỉ được tải lên một tài liệu cùng tên, danh mục và mô tả.',
        INVALID_NAME: 'Tên tài liệu không hợp lệ hoặc vượt quá 500 ký tự.',
        UNSUPPORTED: 'Chỉ hỗ trợ tài liệu PDF, DOCX, MD và TXT.',
        TOO_LARGE: 'Tài liệu không được vượt quá 10 MB.',
        EMPTY: 'Tài liệu rỗng hoặc không có nội dung văn bản đọc được.',
        INVALID_CONTENT: 'Không thể đọc tài liệu. Vui lòng kiểm tra định dạng và nội dung file.',
        DUPLICATE: 'Tên tài liệu đã tồn tại trong kho kiến thức.',
        UNAVAILABLE: 'Không thể nạp tài liệu vào dịch vụ AI. Vui lòng thử lại.',
        TIMEOUT: 'Quá thời gian nạp tài liệu. Hãy kiểm tra kết quả trước khi thử lại.',
    },

    RAG_DOCUMENT_ERRORS: {
        RAG_SOURCE_MISSING:
            'File gốc không còn trên Cloudinary. Vui lòng tải lại file gốc của tài liệu.',
        RAG_STORAGE_AUTH: 'Không có quyền đọc kho lưu trữ. Vui lòng kiểm tra cấu hình Cloudinary.',
        RAG_STORAGE_TIMEOUT: 'Quá thời gian đọc file từ Cloudinary. Vui lòng thử lại.',
        RAG_STORAGE_UNAVAILABLE: 'Chưa thể kết nối hoặc đọc file từ Cloudinary. Vui lòng thử lại.',
        RAG_INVALID_CONTENT:
            'Nội dung, dung lượng hoặc hash file không hợp lệ. Vui lòng kiểm tra file.',
        RAG_INGESTION_TIMEOUT: 'Quá thời gian xử lý RAG. Bạn có thể thử lại xử lý.',
        RAG_INGESTION_FAILED: 'Xử lý RAG chưa hoàn tất. Vui lòng thử lại xử lý.',
        RAG_REUPLOAD_FILE_MISMATCH:
            'File được chọn không khớp bản gốc. Vui lòng chọn file có cùng nội dung và định dạng ban đầu.',
    },

    COMMON: {
        BAD_REQUEST: 'Dữ liệu yêu cầu không hợp lệ',
        NOT_FOUND: 'Không tìm thấy dữ liệu được yêu cầu',
        CONFLICT: 'Dữ liệu đã thay đổi hoặc bị trùng lặp',
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
        EXECUTION_CONFLICT:
            'Dữ liệu vận hành đã thay đổi. Vui lòng tải lại và thử lại với mã ghi nhận cũ.',
        LIST_FETCHED: 'Lấy danh sách kế hoạch vận hành thành công',
        FETCHED: 'Lấy chi tiết kế hoạch vận hành thành công',
        EXECUTED: 'Ghi nhận thực hiện hoạt động thành công',
        STATS_FETCHED: 'Lấy thống kê vận hành thành công',
        NOT_FOUND: 'Không tìm thấy lịch vận hành',
        SCHEDULE_NOT_PLANNED: 'Lịch vận hành không ở trạng thái chờ thực hiện',
        SEASON_NOT_ACTIVE: 'Vụ nuôi không ở trạng thái đang hoạt động',
        NOT_ASSIGNED_TECHNICIAN: 'Bạn không phải là kỹ thuật viên phụ trách vụ nuôi này',
        INSUFFICIENT_INVENTORY: 'Số lượng vật tư trong kho không đủ để thực hiện',
        INSUFFICIENT_INVENTORY_TITLE: 'Tồn kho hợp lệ không đủ để thực hiện vận hành',
        INSUFFICIENT_INVENTORY_CONTENT:
            'Kiểm tra số lượng, hạn sử dụng và hồ sơ của vật tư trước khi thực hiện lại.',
        VARIANCE_REASON_REQUIRED: 'Cần cung cấp lý do khi số lượng chênh lệch vượt mức cho phép',
        INVALID_ACTUAL_QUANTITY: 'Số lượng thực tế phải lớn hơn 0',
        INVALID_IDEMPOTENCY_KEY: 'Mã idempotency_key không hợp lệ',
    },

    // Admin dashboard
    ADMIN_DASHBOARD: {
        FETCHED: 'Lấy tổng quan hệ thống thành công',
    },

    // Owner dashboard
    OWNER_DASHBOARD: {
        FETCHED: 'Lấy tổng quan vận hành thành công',
        FINANCE_FETCHED: 'Lấy thống kê thu chi thành công',
        INVALID_RANGE:
            'Khoảng ngày phải từ trước đến sau, không ở tương lai và không quá 60 tháng.',
    },

    // Disease case
    DISEASE_CASE: {
        EXISTING_CASE: 'Vụ đã có ca chưa giải quyết. Hãy mở ca hiện tại để bổ sung thông tin.',
        CREATED: 'Tạo ca bệnh thành công.',
        RESPONDED: 'Gửi phản hồi ca bệnh thành công.',
        NO_ASSIGNMENT: 'Bạn không còn là kỹ thuật viên phụ trách vụ nuôi này.',
        SEASON_NOT_ACTIVE: 'Chỉ được tạo hoặc phản hồi ca bệnh trong vụ nuôi đang hoạt động.',
        NO_EXPERT: 'Vụ nuôi phải có đúng một chuyên gia đang hoạt động phụ trách.',
        CONFLICT: 'Ca bệnh hoặc phân công đã thay đổi. Vui lòng tải lại.',
        INVALID_RELATED_CASE: 'Ca bệnh liên quan phải thuộc cùng vụ nuôi.',
        INVALID_AI: 'Kết quả AI phải thành công, thuộc lịch sử của bạn và cùng vụ.',
        EMERGENCY: 'Kỹ thuật viên gửi cảnh báo khẩn cấp cho ca bệnh.',
        LIST_FETCHED: 'Lấy danh sách ca bệnh thành công',
        FETCHED: 'Lấy chi tiết ca bệnh thành công',
        NOT_FOUND: 'Không tìm thấy ca bệnh',
        NOT_ASSIGNED: 'Bạn không có quyền truy cập ca bệnh này',
        RESPONSE_SENT: 'Gửi phản hồi thành công',
        RESOLVED: 'Đánh dấu ca bệnh đã giải quyết thành công',
        ALREADY_RESOLVED: 'Ca bệnh đã được giải quyết, không thể thực hiện thêm thao tác',
        RESOLUTION_SUMMARY_REQUIRED: 'Bắt buộc nhập nội dung tóm tắt giải quyết',
        CASE_OR_ROLE_CONFLICT: 'Ca bệnh hoặc phân công đã thay đổi. Vui lòng tải lại.',
        PROTOCOL_RUNNING_BLOCK:
            'Ca đang điều trị. Expert cần dừng hoặc chờ phác đồ kết thúc trước khi khép ca.',
        PROTOCOL_ABORTED: 'Dừng phác đồ điều trị thành công',
    },

    TECHNICIAN_DASHBOARD: {
        FETCHED: 'Lấy tổng quan vận hành thành công',
    },

    TREATMENT_PROTOCOL: {
        PRODUCTION_TEMPLATE_FORBIDDEN:
            'Phác đồ điều trị phải được Expert lập riêng cho ca bệnh, không được áp dụng mẫu phác đồ nuôi.',
        REQUEST_REPLY_INVALID: 'Tin nhắn được trả lời phải tồn tại và thuộc đúng ca bệnh.',
        START_REQUIRED:
            'Cần mốc bắt đầu điều trị hợp lệ trong tương lai, vụ đang hoạt động và đầy đủ khoảng giờ thực hiện trước khi gửi/duyệt.',
        FIRST_OCCURRENCE: 'Cữ ngày điều trị đầu tiên không được trước giờ bắt đầu Expert chỉ định.',
        FIRST_STAGE_DAY: 'Giai đoạn điều trị đầu tiên phải bắt đầu từ ngày điều trị 1.',
        DAY_ONE_REQUIRED:
            'Ngày điều trị 1 cần ít nhất một lần thực hiện từ mốc bắt đầu; hãy sửa lịch hoặc mốc bắt đầu trước khi gửi duyệt.',
        LAST_DAY_REQUIRED:
            'Ngày cuối liệu trình cần có lịch thực hiện. Hãy chỉnh ngày kết thúc giai đoạn hoặc nhịp lặp để không có phần cuối bỏ trống.',
        START_BEFORE_STOCKING:
            'Mốc điều trị phải là ngày giờ hợp lệ và không được trước ngày thả giống của vụ.',
        START_TIMEZONE_REQUIRED: 'Mốc điều trị phải có cả ngày, giờ và múi giờ (Z hoặc ±HH:mm).',
        STATE: 'Trạng thái ca hoặc phác đồ không cho phép thao tác này.',
        REASON_REQUIRED: 'Cần ghi lý do và quyết định cho phác đồ nuôi tiếp tục hoặc tạm giữ.',
        COMPLETED: 'Đã kết thúc thời gian áp dụng phác đồ; Expert cần quyết định chăm sóc tiếp.',
        RECORDING_CLOSED: 'Phác đồ đã kết thúc thời gian áp dụng; lịch đã khóa ghi nhận.',
        REPLACEMENT_DUE:
            'Đã tới mốc thay phác đồ; lịch cũ đã khóa. Vui lòng tải lại và kiểm tra bản điều trị mới.',
        CARE_NOT_PENDING:
            'Ca chưa có quyết định chăm sóc sau điều trị cần xử lý. Vui lòng tải lại ca bệnh.',
        CARE_MONITOR_RECORDED:
            'Đã chọn tiếp tục theo dõi trong đợt này. Bạn có thể bổ sung chỉ dẫn trong trao đổi.',
        CARE_CONTINUATION: 'Đã có phác đồ điều trị tiếp theo được duyệt, đang chờ mốc bắt đầu.',
        CARE_CONFIRM_REQUIRED: 'Vui lòng xác nhận cho phép phác đồ nuôi chạy tiếp.',
        CARE_CLOSE_CONFIRM_REQUIRED:
            'Không còn lịch nuôi để tiếp tục. Vui lòng xác nhận khép ca và kết thúc tạm hoãn của đợt điều trị này.',
        CARE_RESUME_BEFORE_CLOSE:
            'Phác đồ nuôi đang tạm hoãn và vẫn còn lịch có thể tiếp tục. Vui lòng cho phép phác đồ nuôi chạy tiếp trước khi khép ca.',
        CARE_INDEPENDENT_HOLD:
            'Còn quyết định tạm hoãn khác chưa được xử lý. Không thể tự gỡ khi xử lý đợt này.',
        CARE_NO_PRODUCTION:
            'Chưa có phác đồ nuôi đã duyệt để tiếp tục. Hãy lập phác đồ nuôi cho vụ này và gửi Owner duyệt.',
        CARE_PRODUCTION_ENDED:
            'Phác đồ nuôi không còn cữ tương lai để tiếp tục. Hãy lập phác đồ nuôi mới cho vụ này.',
        CARE_PRODUCTION_EXPIRED: (at) =>
            `Phác đồ nuôi đã hết lịch lúc ${at.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}. Hãy lập phác đồ nuôi mới cho vụ này.`,
        CARE_PRODUCTION_UNAPPROVED:
            'Phác đồ nuôi mới chưa được duyệt. Hãy kiểm tra bản đang soạn hoặc chờ Owner duyệt trước khi cho chạy tiếp.',
        CARE_TREATMENT_DUE:
            'Phác đồ điều trị đã tới mốc bắt đầu nhưng chưa thể kích hoạt. Hãy xử lý kế hoạch điều trị trước khi cho nuôi tiếp.',
        CARE_PRODUCTION_INVALID:
            'Phác đồ nuôi còn lịch nhưng vật tư hoặc cấu hình áp dụng chưa hợp lệ. Hãy kiểm tra phác đồ trước khi tiếp tục.',
        CARE_BIOMASS_REQUIRED:
            'Chưa đủ dữ liệu sinh khối hợp lệ để sinh lịch nuôi. Cần KTV bổ sung nhật ký sức khỏe trước khi tiếp tục.',
        CARE_CALCULATION_INVALID:
            'Chưa thể tính lượng cho lịch nuôi tiếp theo. Hãy kiểm tra căn cứ tính liều của phác đồ.',
        HOLD_CHANGED: 'Quyết định tạm hoãn đã thay đổi. Vui lòng tải lại ca bệnh.',
    },

    JOBS: {
        STORAGE_NOT_READY:
            'Hệ thống chưa thể cập nhật lịch vận hành. Vui lòng liên hệ quản trị viên.',
        CALCULATION_CHANGED: 'Căn cứ tính lượng thay đổi hoặc không còn hợp lệ.',
        ACTIVATION_BLOCKED: 'Phác đồ điều trị chưa thể bắt đầu',
        ACTIVATION_BLOCKED_CONTENT: (title) =>
            `${title}: chưa thể kích hoạt. Kiểm tra phân công Expert, trạng thái ca, vật tư và cấu hình liệu trình.`,
    },

    // Server
    SERVER: {
        INTERNAL_ERROR: 'Lỗi máy chủ nội bộ',
        SERVICE_UNAVAILABLE: 'Dịch vụ tạm thời không khả dụng',
        TOO_MANY_REQUESTS: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
    },
};

module.exports = messages;
