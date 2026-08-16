/*
 * Contact form mail handler.
 *
 * Invoked by a Lambda Function URL (POST, JSON body) from the ms3dm.tech contact
 * form. Validates the input, drops obvious bots via a honeypot, and sends the
 * message with Amazon SES. The owner is both From and To (a note to self);
 * ReplyTo is set to the submitter so a reply goes straight back to them. The AWS
 * SDK v3 is provided by the Node.js 20 managed runtime, so nothing is bundled.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const REGION = process.env.AWS_REGION || 'us-east-1';
const FROM_ADDRESS = process.env.FROM_ADDRESS;
const TO_ADDRESS = process.env.TO_ADDRESS;
// Comma-separated list of allowed site origins for CORS.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const ses = new SESv2Client({ region: REGION });

const MAX = { name: 100, email: 254, message: 5000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Resolve the CORS origin: echo the request origin only if it is allowlisted.
const corsOrigin = (event) => {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return ALLOWED_ORIGINS[0] || '';
};

const respond = (event, statusCode, payload) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin(event),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

export const handler = async (event) => {
  const method =
    (event.requestContext &&
      event.requestContext.http &&
      event.requestContext.http.method) ||
    event.httpMethod ||
    'POST';

  // Preflight (Function URL CORS also covers this; handled here as a fallback).
  if (method === 'OPTIONS') {
    return respond(event, 204, {});
  }
  if (method !== 'POST') {
    return respond(event, 405, { ok: false, error: 'Method not allowed.' });
  }

  const data = parseBody(event);
  if (data === null) {
    return respond(event, 400, { ok: false, error: 'Invalid request body.' });
  }

  // Honeypot: a hidden field real users never fill. Pretend success for bots.
  if (clean(data.company, 200)) {
    return respond(event, 200, { ok: true });
  }

  const name = clean(data.fullName || data.name, MAX.name);
  const email = clean(data.email, MAX.email);
  const message = clean(data.message, MAX.message);

  const errors = [];
  if (name.length < 2) errors.push('name');
  if (!EMAIL_RE.test(email)) errors.push('email');
  if (message.length < 1) errors.push('message');
  if (errors.length) {
    return respond(event, 422, {
      ok: false,
      error: `Please check these fields: ${errors.join(', ')}.`,
    });
  }

  const subject = `New contact from ${name} via ms3dm.tech`;
  const text = [
    `Name: ${name}`,
    `Email: ${email}`,
    '',
    message,
  ].join('\n');

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM_ADDRESS,
        Destination: { ToAddresses: [TO_ADDRESS] },
        ReplyToAddresses: [email],
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Text: { Data: text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
  } catch (err) {
    console.error('SES send failed:', err);
    return respond(event, 502, {
      ok: false,
      error: 'The message could not be sent. Please email directly.',
    });
  }

  return respond(event, 200, { ok: true });
};
