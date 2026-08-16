# Contact form mail backend

A small, first-party backend that lets the static ms3dm.tech contact form send
email. The form POSTs JSON to a Lambda Function URL; the Lambda validates the
input and sends the message with Amazon SES.

```
browser (contact form) --> Lambda Function URL --> Amazon SES --> your inbox
```

The owner address is both From and To (a note to self); the submitter address is
set as Reply-To, so replying goes straight back to them. The AWS SDK v3 is
provided by the Node.js 20 runtime, so nothing is bundled.

## What gets created

- Lambda function (`nodejs20.x`) and a public Function URL with CORS locked to
  the site origins.
- Least-privilege IAM role: write to this function's log group, `ses:SendEmail`
  only from the verified identities.
- SES email identities for the From and To addresses (skippable).
- CloudWatch log group with retention.

## Deploy

Requires AWS credentials with permission to manage Lambda, IAM, SES, and logs.

```bash
cd infra/contact
terraform init
terraform apply
```

Useful variables (see `variables.tf`): `aws_region`, `from_address`,
`to_address`, `allowed_origins`, `create_ses_identities`.

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

## Notes

- The Function URL uses `authorization_type = NONE` (a public contact form).
  Abuse is bounded by input size limits and a honeypot field; add WAF or a
  captcha if spam becomes an issue.
- No secrets are stored here; addresses are configuration, not credentials.
