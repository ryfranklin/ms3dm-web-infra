# Contact form mail + lead store

A small, first-party backend that lets the static ms3dm.tech contact form capture
leads and send email. The form POSTs JSON to a Lambda Function URL; the Lambda
validates the input, writes the lead to DynamoDB, then notifies with Amazon SES.

```
browser (contact form)
  --> Lambda Function URL
        --> DynamoDB (lead persist, first)
        --> Amazon SES (notify, best-effort)
              --> your inbox
```

**Persist before notify:** DynamoDB `PutItem` runs first. If SES fails, the lead
is still stored and the client still receives `200`. The handler returns `502`
only when the write fails (or when the write cannot run). Email is best-effort
after a durable capture.

The owner address is both From and To (a note to self); the submitter address is
set as Reply-To, so replying goes straight back to them. The AWS SDK v3 is
provided by the Node.js 20 runtime, so nothing is bundled.

## What gets created

- DynamoDB table for leads (`pk` / `sk`, encryption at rest, optional TTL,
  PITR on by default).
- Lambda function (`nodejs20.x`) and a public Function URL with CORS locked to
  the site origins.
- Least-privilege IAM role: write to this function's log group, `dynamodb:PutItem`
  on the leads table only, `ses:SendEmail` only from the verified identities.
- SES email identities for the From and To addresses (skippable).
- CloudWatch log group with retention; structured `lead_created` log line and
  EMF metric under namespace `ms3dm/Contact`.

## Lead item shape

| Attribute | Notes |
|-----------|-------|
| `pk` | Always `LEAD` (easy Query) |
| `sk` | `{ISO8601}#{uuid}` (newest-first with `ScanIndexForward=false`) |
| `lead_id` | UUID |
| `name`, `email`, `message` | Validated form fields |
| `source_origin` | Body `source`/`origin`, else `Origin` / `Referer` header |
| `user_agent` | Truncated request User-Agent |
| `page` | Optional pathname (+ search) from the browser |
| `referrer` | Optional `document.referrer` |
| `utm_source` / `utm_medium` / `utm_campaign` / `utm_content` / `utm_term` | Optional UTM params (max 100 chars each) |
| `received_at` | ISO8601 UTC |
| `received_at_pt` | Display string in America/Phoenix |
| `ttl` | Epoch seconds when `lead_ttl_days > 0` (default 730) |

## Deploy

Requires AWS credentials with permission to manage Lambda, IAM, SES, DynamoDB,
and logs. Use the contact-stack profile (example):

```bash
cd contact
export AWS_PROFILE=ms3dm-web
terraform init
terraform apply
```

Useful variables (see `variables.tf`): `aws_region`, `from_address`,
`to_address`, `allowed_origins`, `create_ses_identities`, `name_prefix`,
`leads_table_name`, `lead_ttl_days`, `leads_pitr_enabled`.

## One-time SES verification

After `apply`, SES sends a verification email to each identity. Click the link
in each before delivery works. Check `terraform output ses_identities`.

Sandbox note: a brand-new SES account is in the sandbox, where you can send only
to verified addresses. That is fine here, because both From and To are the owner
address (verified). You do NOT need production access for this to work. If you
later want SES to email arbitrary people, request production access. If the
domain `ms3dm.tech` is already a verified SES domain identity, set
`create_ses_identities = false`.

## Wire the site to the endpoint

Take the `function_url` output and set it as the contact endpoint the SPA reads
at runtime (no rebuild needed if your host templates `env.js`):

```js
// public/env.js
window.env = {
  // ...
  REACT_APP_CONTACT_ENDPOINT: 'https://<id>.lambda-url.<region>.on.aws/',
};
```

If the endpoint is left blank, the form falls back to opening the visitor's mail
client via `mailto:`, so the page always works.

```bash
terraform output function_url
```

## List recent leads

```bash
export AWS_PROFILE=ms3dm-web
aws dynamodb query \
  --table-name "$(terraform -chdir=contact output -raw leads_table_name 2>/dev/null || echo ms3dm-contact-leads)" \
  --key-condition-expression 'pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"LEAD"}}' \
  --no-scan-index-forward \
  --limit 20 \
  --region us-east-1
```

Or, from anywhere once you know the table name (default `ms3dm-contact-leads`):

```bash
AWS_PROFILE=ms3dm-web aws dynamodb query \
  --table-name ms3dm-contact-leads \
  --key-condition-expression 'pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"LEAD"}}' \
  --no-scan-index-forward \
  --limit 20 \
  --region us-east-1
```

## Notes

- The Function URL uses `authorization_type = NONE` (a public contact form).
  Abuse is bounded by input size limits and a honeypot field; add WAF or a
  captcha if spam becomes an issue.
- CORS is owned ONLY by the Function URL. Do not re-add `Access-Control-*`
  headers in the Lambda response.
- No secrets are stored here; addresses are configuration, not credentials.
- This stack is the Phase 1 dogfood for the Governed Lead Capture Walk offer.
