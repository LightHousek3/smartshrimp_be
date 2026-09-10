const nodemailer = require('nodemailer');
const config = require('../config');

const transporter = nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.port === 465,
    auth: config.email.smtp.auth,
});

const sendAccountActivationEmail = async ({ email, code, expiresInMinutes }) =>
    transporter.sendMail({
        from: config.email.from,
        to: email,
        subject: 'Kích hoạt tài khoản SmartShrimp',
        text: [
            'Bạn đã được mời sử dụng hệ thống SmartShrimp.',
            `Mã kích hoạt của bạn là: ${code}`,
            `Mã có hiệu lực trong ${expiresInMinutes} phút.`,
            'Nếu bạn không yêu cầu tài khoản này, hãy bỏ qua email.',
        ].join('\n\n'),
    });

module.exports = {
    sendAccountActivationEmail,
};
