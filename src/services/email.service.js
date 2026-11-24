const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../config/logger');
const { VERIFICATION_PURPOSE, ACCOUNT_ROLE } = require('../constants');

const BRAND_NAME = 'SmartShrimp';
const LOGO_URL = 'https://res.cloudinary.com/dmv1uhpq/image/upload/v1789054756/logo.png';
const EMAIL_FONT_FAMILY = 'Arial, Helvetica, sans-serif';

const EMAIL_CONTENT_BY_PURPOSE = {
    [VERIFICATION_PURPOSE.ACCOUNT_ACTIVATION]: {
        subject: 'Mã OTP kích hoạt tài khoản SmartShrimp',
        badge: 'Kích hoạt tài khoản',
        title: 'Hoàn tất kích hoạt tài khoản',
        greeting: 'Chào mừng bạn đến với SmartShrimp,',
        intro: 'Quay lại màn hình kích hoạt tài khoản trên App hoặc Web đang thao tác và nhập mã OTP bên dưới. Sau khi xác minh email, bạn có thể hoàn tất hồ sơ và thiết lập mật khẩu đăng nhập.',
        note: 'Nếu bạn không yêu cầu kích hoạt tài khoản SmartShrimp, vui lòng bỏ qua email này.',
        actionName: 'kích hoạt tài khoản',
    },
    [VERIFICATION_PURPOSE.PASSWORD_RESET]: {
        subject: 'Mã OTP đặt lại mật khẩu SmartShrimp',
        badge: 'Quên mật khẩu',
        title: 'Đặt lại mật khẩu SmartShrimp',
        greeting: 'SmartShrimp đã nhận yêu cầu đặt lại mật khẩu,',
        intro: 'Quay lại màn hình quên mật khẩu trên App hoặc Web đang thao tác và nhập mã OTP bên dưới để tiếp tục đặt lại mật khẩu.',
        note: 'Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này và giữ bí mật thông tin đăng nhập.',
        actionName: 'đặt lại mật khẩu',
    },
};

const ACTIVATION_INVITE_CONTENT = {
    subject: 'Lời mời kích hoạt tài khoản SmartShrimp',
    title: 'Bạn được mời kích hoạt tài khoản',
    greeting: 'Chào mừng bạn đến với SmartShrimp,',
    intro: 'Quản trị viên đã khởi tạo tài khoản cho bạn. Vui lòng mở liên kết kích hoạt bên dưới để xác minh email, hoàn tất hồ sơ và thiết lập mật khẩu đăng nhập.',
    actionName: 'kích hoạt tài khoản',
};

let transporter;

/**
 * Lazily create and reuse the SMTP transporter.
 */
const getTransporter = () => {
    if (!transporter) {
        const { host, port, auth } = config.email.smtp;
        transporter = nodemailer.createTransport({
            host,
            port,
            secure: port === 465,
            ...(auth.user && auth.pass ? { auth } : {}),
        });
    }

    return transporter;
};

/**
 * Escape interpolated values before inserting them into HTML email markup.
 */
const escapeHtml = (value) =>
    String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/**
 * Choose purpose-specific OTP copy and fall back to a general verification message.
 */
const getEmailContent = (purpose) =>
    EMAIL_CONTENT_BY_PURPOSE[purpose] || {
        subject: `Mã xác minh ${BRAND_NAME}`,
        badge: 'Xác minh email',
        title: `Xác minh email ${BRAND_NAME}`,
        greeting: `${BRAND_NAME} đã nhận yêu cầu xác minh email,`,
        intro: 'Vui lòng dùng mã OTP bên dưới để tiếp tục thao tác trên hệ thống.',
        note: 'Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email.',
        actionName: 'xác minh email',
    };

/**
 * Provide a plain-text equivalent with the relevant activation instructions or OTP expiry.
 */
const buildTextEmail = ({ code, content, expiresMinutes, instructions = '' }) =>
    [
        content.greeting,
        content.intro,
        instructions,
        ...(code
            ? [
                  `Mã OTP để ${content.actionName} của bạn là ${code}.`,
                  `Mã có hiệu lực trong ${expiresMinutes} phút.`,
                  'Vui lòng không chia sẻ mã này với bất kỳ ai.',
              ]
            : []),
        ...(content.note ? [content.note] : []),
        `${BRAND_NAME} Team`,
    ]
        .filter(Boolean)
        .join('\n\n');

/**
 * Render a branded email with escaped copy and optional OTP or invitation instructions.
 */
const buildHtmlEmail = ({ code, content, expiresMinutes, instructions = '' }) => {
    const safeCode = code ? escapeHtml(code) : '';

    return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f2f7f5;color:#18352c;font-family:${EMAIL_FONT_FAMILY};font-size:16px;line-height:1.625;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f2f7f5;margin:0;padding:28px 12px;font-family:${EMAIL_FONT_FAMILY};font-size:16px;line-height:1.625;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dceae5;box-shadow:0 16px 42px rgba(24,53,44,0.10);font-family:${EMAIL_FONT_FAMILY};font-size:16px;line-height:1.625;">
          <tr>
            <td style="background-image:linear-gradient(to top, #fff1eb 0%, #ace0f9 100%);">
              <img src="${LOGO_URL}" width="220" alt="${BRAND_NAME}" draggable="false" style="display:block;margin:0 auto 14px auto;width:220px;max-width:220px;height:auto;border:0;outline:none;text-decoration:none;user-select:none;-webkit-user-drag:none;">
            </td>
          </tr>
          <tr>
            <td style="padding:34px 32px 12px 32px;">
              <h2 style="margin:0 0 14px 0;font-family:${EMAIL_FONT_FAMILY};font-size:26px;line-height:34px;color:#123b31;font-weight:700;">${escapeHtml(content.title)}</h2>
              <p style="margin:0 0 10px 0;font-size:16px;line-height:26px;color:#36574f;">${escapeHtml(content.greeting)}</p>
              <p style="margin:0;font-size:16px;line-height:26px;color:#36574f;">${escapeHtml(content.intro)}</p>
              ${instructions}
            </td>
          </tr>
          ${
              code
                  ? `<tr>
            <td style="padding:22px 32px 18px 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#eefaf6;border:1px solid #bfe7db;border-radius:14px;font-family:${EMAIL_FONT_FAMILY};font-size:16px;line-height:1.625;">
                <tr>
                  <td align="center" style="padding:24px 16px;">
                    <div style="font-size:13px;line-height:18px;color:#4b6f66;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">Mã OTP của bạn</div>
                    <div style="font-size:34px;line-height:42px;color:#0b6e5b;font-weight:700;letter-spacing:8px;font-family:${EMAIL_FONT_FAMILY};font-variant-numeric:tabular-nums;">${safeCode}</div>
                    <div style="font-size:14px;line-height:22px;color:#4b6f66;margin-top:12px;">Có hiệu lực trong <strong>${escapeHtml(expiresMinutes)} phút</strong></div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
                  : ''
          }
          <tr>
            <td style="padding:0 32px 30px 32px;">
              ${code ? '<p style="margin:0 0 12px 0;font-size:14px;line-height:23px;color:#5d786f;">Vì lý do bảo mật, vui lòng không chia sẻ mã này với bất kỳ ai. SmartShrimp sẽ không bao giờ yêu cầu bạn cung cấp OTP qua điện thoại hoặc tin nhắn riêng.</p>' : ''}
              ${content.note ? `<p style="margin:0;font-size:14px;line-height:23px;color:#5d786f;">${escapeHtml(content.note)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="background:#f8fbfa;padding:20px 32px;text-align:center;border-top:1px solid #e5efeb;">
              <p style="margin:0;font-size:13px;line-height:21px;color:#769188;">Email tự động từ ${BRAND_NAME}. Vui lòng không trả lời email này.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

/**
 * Build both mail formats using the same verification lifetime.
 */
const buildEmail = ({ code, content, instructions }) => {
    const expiresMinutes = config.email.verificationExpiresMinutes;
    return {
        subject: content.subject,
        text: buildTextEmail({ code, content, expiresMinutes, instructions: instructions?.text }),
        html: buildHtmlEmail({ code, content, expiresMinutes, instructions: instructions?.html }),
    };
};

/**
 * Select the OTP template for the verification purpose so the email identifies the requested action.
 */
const buildOtpEmail = ({ code, purpose }) =>
    buildEmail({ code, content: getEmailContent(purpose) });

/**
 * Offer mobile links to owner and technician accounts and a web activation link to every role.
 */
const buildInvitationInstructions = ({ email, role }) => {
    const path = '/activate-account?email=' + encodeURIComponent(email);
    const web = config.app.webBaseUrl + path;
    const mobile = 'smartshrimp://' + path;
    const useApp = [ACCOUNT_ROLE.FARM_OWNER, ACCOUNT_ROLE.TECHNICIAN].includes(role);
    const fallback = 'Chưa cài App hoặc đang dùng máy tính?';
    const prefill = 'Hãy yêu cầu mã xác minh tại màn hình kích hoạt để tiếp tục.';
    const appLink = useApp
        ? `Đã cài App trên điện thoại? <a href="${escapeHtml(mobile)}">Mở ứng dụng SmartShrimp</a><br>`
        : '';
    return {
        text: [
            ...(useApp
                ? [`Đã cài App trên điện thoại? Mở ứng dụng SmartShrimp: ${mobile}`, fallback]
                : []),
            `Tiếp tục trên Web: ${web}`,
            prefill,
        ].join('\n'),
        html: `<p style="margin:16px 0;font-family:${EMAIL_FONT_FAMILY};font-size:16px;line-height:26px;">${appLink}${useApp ? fallback + ' ' : ''}<a href="${escapeHtml(web)}">Tiếp tục trên Web</a><br>${prefill}</p>`,
    };
};

/** Keep SMTP diagnostics separate from recipient details and verification secrets. */
const sendEmail = async (email, content) => {
    try {
        await getTransporter().sendMail({
            from: config.email.from,
            to: email,
            ...content,
        });
    } catch (error) {
        const code = /^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : 'UNKNOWN';
        const responseCode = Number.isInteger(error?.responseCode) ? error.responseCode : 'unknown';
        logger.error(`Email delivery failed: code=${code} responseCode=${responseCode}`);
        throw error;
    }
};

/**
 * Deliver the OTP for the requested verification purpose to the account email.
 */
const sendOtp = ({ email, code, purpose }) => sendEmail(email, buildOtpEmail({ code, purpose }));

/**
 * Build the invitation with activation links that lead the recipient to request their own OTP.
 */
const buildActivationInviteEmail = ({ email, role }) =>
    buildEmail({
        content: ACTIVATION_INVITE_CONTENT,
        instructions: buildInvitationInstructions({ email, role }),
    });

/**
 * Deliver the account activation invitation using the links available to the recipient's role.
 */
const sendAccountActivationEmail = ({ email, role }) =>
    sendEmail(email, buildActivationInviteEmail({ email, role }));

module.exports = { buildOtpEmail, buildActivationInviteEmail, sendOtp, sendAccountActivationEmail };
