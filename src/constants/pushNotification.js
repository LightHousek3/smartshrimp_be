module.exports = Object.freeze({
    channelId: 'smartshrimp_alerts',
    intervalMs: 5000,
    leaseMs: 120000,
    maxAttempts: 5,
    maxAgeMs: 86400000,
    batchSize: 50,
    tokenLimit: 4096,
    messages: Object.freeze({
        REGISTERED: 'Đã đăng ký thiết bị nhận thông báo.',
        SESSION_REQUIRED: 'Thiết bị chưa có phiên đăng nhập hợp lệ. Vui lòng đăng nhập lại.',
        UNAVAILABLE: 'Máy chủ chưa được cấu hình gửi thông báo thiết bị.',
        CONFLICT: 'Phiên thiết bị đã thay đổi. Vui lòng thử lại.',
    }),
});
