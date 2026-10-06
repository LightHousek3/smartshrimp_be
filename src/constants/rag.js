const STATUS = { ANSWERED: 'ANSWERED', NO_SOURCE: 'NO_SOURCE', LOW_MATCH: 'LOW_MATCH', ERROR: 'ERROR' };
const WARNINGS = {
    NO_SOURCE: 'Chưa tìm thấy nguồn tham chiếu. Vui lòng kiểm chứng câu trả lời trước khi áp dụng.',
    LOW_MATCH: 'Nguồn tham chiếu có độ liên quan thấp. Vui lòng kiểm chứng câu trả lời trước khi áp dụng.',
};
const MESSAGES = {
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
};
module.exports = { STATUS, WARNINGS, MESSAGES };
