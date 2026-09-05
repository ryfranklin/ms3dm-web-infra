/*
 * Contact form mail + lead-persistence handler.
 *
 * Invoked by a Lambda Function URL (POST, JSON body) from the ms3dm.tech contact
 * form. Validates the input, drops obvious bots via a honeypot, writes the lead
 * to DynamoDB first, then sends the message with Amazon SES. Persist-before-
 * notify: if SES fails the lead is still stored and the client still gets 200.
 * Return 502 only when the DynamoDB write fails (or both paths fail because
 * write failed first). The owner is both From and To (a note to self); ReplyTo
 * is set to the submitter so a reply goes straight back to them. The AWS SDK
 * v3 is provided by the Node.js 20 managed runtime, so nothing is bundled.
 *
 * Optional Slack: when SLACK_WEBHOOK_URL is set, POST a soft-fail notification
 * after SES (errors are logged only; DDB success still returns 200).
 *
 * CORS is owned ONLY by the Function URL (see contact/main.tf cors block).
 * Do not set Access-Control-* here or browsers see duplicate ACAO values and
 * fail the fetch even after SES has already sent the mail.
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { randomUUID } from 'node:crypto';

const REGION = process.env.AWS_REGION || 'us-east-1';
const FROM_ADDRESS = process.env.FROM_ADDRESS;
const TO_ADDRESS = process.env.TO_ADDRESS;
const LEADS_TABLE_NAME = process.env.LEADS_TABLE_NAME;
const LEAD_TTL_DAYS = Number(process.env.LEAD_TTL_DAYS || '0');
const SLACK_WEBHOOK_URL = (process.env.SLACK_WEBHOOK_URL || '').trim();
const CALENDLY_URL = 'https://calendly.com/ryan-franklin/30min';

const ses = new SESv2Client({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

const s = (value) => ({ S: String(value) });
const n = (value) => ({ N: String(value) });

const MAX = {
  name: 100,
  email: 254,
  message: 5000,
  userAgent: 256,
  page: 500,
  referrer: 500,
  utm: 100,
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ATTR_KEYS = [
  'page',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
];

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

const headerValue = (event, name) => {
  const headers = event.headers || {};
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return '';
};

const extractAttribution = (data) => {
  const attribution = {};
  for (const key of ATTR_KEYS) {
    const limit = key === 'page' || key === 'referrer' ? MAX.page : MAX.utm;
    const value = clean(data[key], limit);
    if (value) {
      attribution[key] = value;
    }
  }
  return attribution;
};

const attributionLines = (attribution) =>
  ATTR_KEYS.filter((key) => attribution[key]).map(
    (key) => `${key}: ${attribution[key]}`,
  );

const attributionOneLiner = (attribution) => {
  const parts = attributionLines(attribution);
  return parts.length ? parts.join(' | ') : '(none)';
};

const buildTextBody = ({ name, email, message, receivedAt, leadId, attribution }) => {
  const lines = [
    'New contact via ms3dm.tech',
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    `Received: ${receivedAt}`,
    `Lead ID: ${leadId}`,
    '',
    'Message',
    '-------',
    message,
  ];

  const attr = attributionLines(attribution);
  if (attr.length) {
    lines.push('', 'Attribution', '-----------', ...attr);
  }

  lines.push('', 'Reply to this email to respond to the submitter.');
  return lines.join('\n');
};

const buildHtmlBody = ({ name, email, message, receivedAt, leadId, attribution }) => {
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br />');
  const safeReceived = escapeHtml(receivedAt);
  const safeLeadId = escapeHtml(leadId);

  const attrRows = ATTR_KEYS.filter((key) => attribution[key])
    .map(
      (key) => `
                <tr>
                  <td style="padding:0 0 12px 0;color:#9aa3ad;width:88px;vertical-align:top;">${escapeHtml(key)}</td>
                  <td style="padding:0 0 12px 0;color:#c5cad1;word-break:break-all;">${escapeHtml(attribution[key])}</td>
                </tr>`,
    )
    .join('');

  const attributionSection = attrRows
    ? `
              <div style="margin-top:16px;padding:16px;background:#0b0d10;border:1px solid #2a3038;border-radius:8px;">
                <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9aa3ad;margin-bottom:10px;">Attribution</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;line-height:1.5;">
                  ${attrRows}
                </table>
              </div>`
    : '';

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
                  <td style="padding:0 0 12px 0;color:#9aa3ad;vertical-align:top;">Received</td>
                  <td style="padding:0 0 12px 0;color:#c5cad1;">${safeReceived}</td>
                </tr>
                <tr>
                  <td style="padding:0 0 16px 0;color:#9aa3ad;vertical-align:top;">Lead ID</td>
                  <td style="padding:0 0 16px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;color:#c5cad1;">${safeLeadId}</td>
                </tr>
              </table>
              <div style="margin-top:4px;padding:16px;background:#0b0d10;border:1px solid #2a3038;border-radius:8px;">
                <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#9aa3ad;margin-bottom:10px;">Message</div>
                <div style="font-size:15px;line-height:1.65;color:#e8eaed;">${safeMessage}</div>
              </div>
              ${attributionSection}
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

const notifySlack = async ({ name, email, leadId, receivedAt, attribution }) => {
  if (!SLACK_WEBHOOK_URL) {
    return null;
  }

  const attrLine = attributionOneLiner(attribution);
  const text = [
    `New ms3dm.tech lead: ${name} <${email}>`,
    `Lead ID: ${leadId}`,
    `Received: ${receivedAt}`,
    `Attribution: ${attrLine}`,
    `Book: ${CALENDLY_URL}`,
  ].join('\n');

  const payload = {
    text,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'New ms3dm.tech lead', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Name*\n${name}` },
          { type: 'mrkdwn', text: `*Email*\n${email}` },
          { type: 'mrkdwn', text: `*Lead ID*\n\`${leadId}\`` },
          { type: 'mrkdwn', text: `*Received*\n${receivedAt}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Attribution*\n${attrLine}` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open Calendly', emoji: true },
            url: CALENDLY_URL,
          },
        ],
      },
    ],
  };

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Slack webhook HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
};

const emitLeadCreated = ({ leadId, sourceOrigin, emailOk, slackOk }) => {
  // CloudWatch Embedded Metric Format + a plain JSON line for Logs Insights.
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'ms3dm/Contact',
          Dimensions: [['Service']],
          Metrics: [{ Name: 'lead_created', Unit: 'Count' }],
        },
      ],
    },
    Service: 'contact-mailer',
    lead_created: 1,
    lead_id: leadId,
    source_origin: sourceOrigin || 'unknown',
    email_ok: Boolean(emailOk),
    slack_ok: slackOk,
  };
  console.log(JSON.stringify(emf));
  console.log(
    JSON.stringify({
      event: 'lead_created',
      lead_id: leadId,
      source_origin: sourceOrigin || 'unknown',
      email_ok: Boolean(emailOk),
      slack_ok: slackOk,
    }),
  );
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

  if (!LEADS_TABLE_NAME) {
    console.error('LEADS_TABLE_NAME is not configured');
    return respond(502, {
      ok: false,
      error: 'The message could not be sent. Please email directly.',
    });
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
  const attribution = extractAttribution(data);

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

  const now = new Date();
  const receivedAtIso = now.toISOString();
  const receivedAt = now.toLocaleString('en-US', {
    timeZone: 'America/Phoenix',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' PT';

  const leadId = randomUUID();
  const sourceOrigin =
    clean(data.source || data.origin, 200) ||
    clean(headerValue(event, 'origin'), 200) ||
    clean(headerValue(event, 'referer'), 200);
  const userAgent = clean(headerValue(event, 'user-agent'), MAX.userAgent);

  const item = {
    pk: s('LEAD'),
    sk: s(`${receivedAtIso}#${leadId}`),
    lead_id: s(leadId),
    name: s(name),
    email: s(email),
    message: s(message),
    source_origin: s(sourceOrigin || 'unknown'),
    received_at: s(receivedAtIso),
    received_at_pt: s(receivedAt),
  };

  for (const key of ATTR_KEYS) {
    if (attribution[key]) {
      item[key] = s(attribution[key]);
    }
  }

  if (userAgent) {
    item.user_agent = s(userAgent);
  }

  if (Number.isFinite(LEAD_TTL_DAYS) && LEAD_TTL_DAYS > 0) {
    item.ttl = n(Math.floor(now.getTime() / 1000) + LEAD_TTL_DAYS * 24 * 60 * 60);
  }

  try {
    await ddb.send(
      new PutItemCommand({
        TableName: LEADS_TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
  } catch (err) {
    console.error('DynamoDB PutItem failed:', err);
    return respond(502, {
      ok: false,
      error: 'The message could not be sent. Please email directly.',
    });
  }

  const subject = `New contact from ${name} via ms3dm.tech`;
  const text = buildTextBody({ name, email, message, receivedAt, leadId, attribution });
  const html = buildHtmlBody({ name, email, message, receivedAt, leadId, attribution });

  let emailOk = false;
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
    emailOk = true;
  } catch (err) {
    // Lead is already durable; do not fail the client for notify-only errors.
    console.error('SES send failed after lead persist:', err);
  }

  // Soft-fail Slack: null = disabled, true = ok, false = attempted and failed.
  let slackOk = null;
  if (SLACK_WEBHOOK_URL) {
    try {
      await notifySlack({ name, email, leadId, receivedAt, attribution });
      slackOk = true;
    } catch (err) {
      slackOk = false;
      console.error('Slack notify failed after lead persist:', err);
    }
  }

  emitLeadCreated({ leadId, sourceOrigin, emailOk, slackOk });

  return respond(200, { ok: true });
};
