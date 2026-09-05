/*
 * Contact form mail handler.
 *
 * Invoked by a Lambda Function URL (POST, JSON body) from the ms3dm.tech contact
 * form. Validates the input, drops obvious bots via a honeypot, and sends the
 * message with Amazon SES. The owner is both From and To (a note to self);
 * ReplyTo is set to the submitter so a reply goes straight back to them. The AWS
 * SDK v3 is provided by the Node.js 20 managed runtime, so nothing is bundled.
 *
 * CORS is owned ONLY by the Function URL (see contact/main.tf cors block).
 * Do not set Access-Control-* here or browsers see duplicate ACAO values and
 * fail the fetch even after SES has already sent the mail.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const REGION = process.env.AWS_REGION || 'us-east-1';
const FROM_ADDRESS = process.env.FROM_ADDRESS;
const TO_ADDRESS = process.env.TO_ADDRESS;

const ses = new SESv2Client({ region: REGION });

const MAX = { name: 100, email: 254, message: 5000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const respond = (statusCode, payload) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(payload),
});

const parseBody = (event) => {
  if (!event.body) {
    return {};
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
};

const clean = (value, limit) => String(value == null ? '' : value).trim().slice(0, limit);

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildTextBody = ({ name, email, message, receivedAt }) =>
  [
    'New contact via ms3dm.tech',
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    `Received: ${receivedAt}`,
    '',
    'Message',
    '-------',
    message,
    '',
    'Reply to this email to respond to the submitter.',
  ].join('\n');

const buildHtmlBody = ({ name, email, message, receivedAt }) => {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br />');
  const safeReceived = escapeHtml(receivedAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>New contact via ms3dm.tech</title>
</head>
<body style="margin:0;padding:0;background:#0b0d10;color:#e8eaed;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0d10;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#12161c;border:1px solid #2a3038;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:20px 24px;border-bottom:1px solid #2a3038;background:#0f1318;">
              <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;letter-spacing:0.04em;color:#9aa3ad;">ms3dm.tech</div>
              <div style="margin-top:6px;font-size:18px;font-weight:600;color:#f3f4f6;">New contact submission</div>
            </td>
          </tr>
          <tr>
            <td style="padding:24px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.5;">
                <tr>
                  <td style="padding:0 0 12px 0;color:#9aa3ad;width:88px;vertical-align:top;">Name</td>
                  <td style="padding:0 0 12px 0;color:#f3f4f6;font-weight:600;">${safeName}</td>
                </tr>
                <tr>
                  <td style="padding:0 0 12px 0;color:#9aa3ad;vertical-align:top;">Email</td>
                  <td style="padding:0 0 12px 0;"><a href="mailto:${safeEmail}" style="color:#8ab4ff;text-decoration:none;">${safeEmail}</a></td>
                </tr>
                <tr>
                  <td style="padding:0 0 16px 0;color:#9aa3ad;vertical-align:top;">Received</td>
                  <td style="padding:0 0 16px 0;color:#c5cad1;">${safeReceived}</td>
                </tr>
              </table>
              <div style="margin-top:4px;padding:16px;background:#0b0d10;border:1px solid #2a3038;border-radius:8px;">
                <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9aa3ad;margin-bottom:10px;">Message</div>
                <div style="font-size:15px;line-height:1.65;color:#e8eaed;">${safeMessage}</div>
              </div>
              <p style="margin:20px 0 0 0;font-size:13px;line-height:1.5;color:#9aa3ad;">
                Reply to this email to respond directly to the submitter.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

export const handler = async (event) => {
  const method =
    (event.requestContext &&
      event.requestContext.http &&
      event.requestContext.http.method) ||
    event.httpMethod ||
    'POST';

  // Preflight is handled by Function URL CORS; keep a harmless fallback.
  if (method === 'OPTIONS') {
    return respond(204, {});
  }
  if (method !== 'POST') {
    return respond(405, { ok: false, error: 'Method not allowed.' });
  }

  const data = parseBody(event);
  if (data === null) {
    return respond(400, { ok: false, error: 'Invalid request body.' });
  }

  // Honeypot: a hidden field real users never fill. Pretend success for bots.
  if (clean(data.company, 200)) {
    return respond(200, { ok: true });
  }

  const name = clean(data.fullName || data.name, MAX.name);
  const email = clean(data.email, MAX.email);
  const message = clean(data.message, MAX.message);

  const errors = [];
  if (name.length < 2) errors.push('name');
  if (!EMAIL_RE.test(email)) errors.push('email');
  if (message.length < 1) errors.push('message');
  if (errors.length) {
    return respond(422, {
      ok: false,
      error: `Please check these fields: ${errors.join(', ')}.`,
    });
  }

  const receivedAt = new Date().toLocaleString('en-US', {
    timeZone: 'America/Phoenix',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' PT';

  const subject = `New contact from ${name} via ms3dm.tech`;
  const text = buildTextBody({ name, email, message, receivedAt });
  const html = buildHtmlBody({ name, email, message, receivedAt });

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM_ADDRESS,
        Destination: { ToAddresses: [TO_ADDRESS] },
        ReplyToAddresses: [email],
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: text, Charset: 'UTF-8' },
              Html: { Data: html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
  } catch (err) {
    console.error('SES send failed:', err);
    return respond(502, {
      ok: false,
      error: 'The message could not be sent. Please email directly.',
    });
  }

  return respond(200, { ok: true });
};
