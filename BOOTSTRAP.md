# Bootstrap: ms3dm-web account for the contact backend

Stand up a dedicated public web workload account in your existing AWS
Organization, then deploy the `infra/contact` module into it. This keeps the
unauthenticated, internet-facing contact Function URL out of the account that
holds your data lake and Homebase.

Observed environment (from a read-only check on 2026-08-15):

- Organization: `<ORG_ID>`, management account `<MGMT_ACCOUNT_ID>`
  (`<mgmt-root-email>`), SCPs enabled.
- Current workload account `<DATA_ACCOUNT_ID>` holds the data lake (S3 + Glue) and
  Homebase (Lambda). This is what we are isolating the web backend away from.
- Public DNS for `ms3dm.tech` is at IONOS, not Route 53.
- SES is in the sandbox with zero verified identities.

## Values reference (variable : value)

| Item | Value | Notes |
| --- | --- | --- |
| New account name | `ms3dm-web` | |
| New account root email | `<web-account-root-email>` | Must be unique and deliverable. Confirm this Google Workspace alias exists (see below). |
| Root email fallback | `<web-account-root-email>` | Google plus-addressing routes to your existing `aws-mgmt` inbox; no new mailbox needed. |
| Organization id | `<ORG_ID>` | Existing. |
| Management account | `<MGMT_ACCOUNT_ID>` | Run account creation from here. |
| Cross-account role | `OrganizationAccountAccessRole` | Default role Organizations creates in the new account. |
| Local AWS profile | `ms3dm-web` | Used for `terraform apply`. |
| `aws_region` | `us-east-1` | SES + Lambda region. |
| `name_prefix` | `ms3dm-contact` | Resource name prefix. |
| `from_address` | `<owner-email>` | SES From (verified identity). |
| `to_address` | `<owner-email>` | Where messages land. From = To keeps you in the SES sandbox. |
| `allowed_origins` | `["https://ms3dm.tech", "https://www.ms3dm.tech"]` | CORS allowlist. |
| `create_ses_identities` | `true` | Creates the email identity to verify. |
| `log_retention_days` | `30` | CloudWatch retention. |

### About the root email

Each AWS account needs its own root email; you cannot reuse
`<mgmt-root-email>`. Two options, both on your `ms3dm.tech` Google Workspace:

1. Recommended: create the alias `<web-account-root-email>` (parallel to
   `<mgmt-root-email>`) and use it.
2. Zero setup: use `<web-account-root-email>`. Google Workspace delivers
   plus-subaddresses to the base `aws-mgmt` inbox, and AWS treats it as a
   distinct address. Good enough for a root email you rarely touch.

## Step 1: Create the account (run in the management account <MGMT_ACCOUNT_ID>)

Console: Organizations, AWS accounts, Add an AWS account, Create an account.
Name `ms3dm-web`, email as above.

CLI:

```bash
# Authenticate as the management account first (SSO or a mgmt profile), then:
aws organizations create-account \
  --account-name "ms3dm-web" \
  --email "<web-account-root-email>" \
  --iam-user-access-to-billing DENY

# Poll until SUCCEEDED and capture the new account id:
aws organizations describe-create-account-status \
  --create-account-request-id <RequestId-from-previous-output> \
  --query 'CreateAccountStatus.{State:State,AccountId:AccountId,Reason:FailureReason}'
```

Record the new account id (referred to below as `<WEB_ACCOUNT_ID>`).

## Step 2: Get access to the new account

Organizations creates `OrganizationAccountAccessRole` in the new account,
assumable from the management account. Add a local profile that chains through
your management credentials:

```ini
# ~/.aws/config
[profile ms3dm-web]
role_arn       = arn:aws:iam::<WEB_ACCOUNT_ID>:role/OrganizationAccountAccessRole
source_profile = ms3dm-mgmt          # your existing profile for <MGMT_ACCOUNT_ID>
region         = us-east-1
```

If you use IAM Identity Center instead, assign yourself to `ms3dm-web` there and
create an `sso-session` based profile named `ms3dm-web` instead.

Verify:

```bash
AWS_PROFILE=ms3dm-web aws sts get-caller-identity
```

## Step 3 (optional, recommended): keep it web-only with an SCP

From the management account, attach an SCP to `ms3dm-web` that denies the
services this account should never run (for example S3 data-lake access, Glue,
Bedrock, SageMaker), so a compromise of the public endpoint cannot reach lake
or model services. Start permissive and tighten; test with the module deploy
below still succeeding (it needs only Lambda, IAM, SES, and CloudWatch Logs).

## Step 4 (optional, recommended): remote Terraform state

Local state is fine to start. To share state, create an S3 bucket and a
DynamoDB lock table in `ms3dm-web`, then add a `backend.tf`:

```hcl
terraform {
  backend "s3" {
    bucket         = "ms3dm-web-tfstate"      # create this bucket first
    key            = "contact/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "ms3dm-web-tflock"       # create this table first
    encrypt        = true
  }
}
```

## Step 5: Deploy the contact module into ms3dm-web

```bash
cd infra/contact

# Point Terraform at the new account.
export AWS_PROFILE=ms3dm-web

# Optional: pin the values (this file is gitignored).
cat > ms3dm-web.auto.tfvars <<'TFVARS'
aws_region            = "us-east-1"
name_prefix           = "ms3dm-contact"
from_address          = "<owner-email>"
to_address            = "<owner-email>"
allowed_origins       = ["https://ms3dm.tech", "https://www.ms3dm.tech"]
create_ses_identities = true
log_retention_days    = 30
TFVARS

terraform init
terraform apply
```

The provider has no hardcoded profile, so `AWS_PROFILE` selects the account. No
code change is needed to target `ms3dm-web`.

## Step 6: Verify SES

After apply, SES sends a verification email to `<owner-email>`. Click
the link once. Because From = To = your address, the SES sandbox is sufficient;
you do NOT need production access. Check:

```bash
AWS_PROFILE=ms3dm-web aws sesv2 list-email-identities --region us-east-1 \
  --query 'EmailIdentities[].{Id:IdentityName,Verified:VerifiedForSendingStatus}' --output table
```

Optional upgrade: verify the whole `ms3dm.tech` domain instead of one address
(better deliverability via DKIM, and you can send From `contact@ms3dm.tech`
without a mailbox). That requires adding SES DKIM CNAME records in IONOS DNS.

## Step 7: Wire the site to the endpoint

```bash
AWS_PROFILE=ms3dm-web terraform -chdir=infra/contact output function_url
```

Set that value as `REACT_APP_CONTACT_ENDPOINT` in `public/env.js` (or your IONOS
runtime env) and redeploy the site. Until then the form falls back to a
`mailto:` compose, so nothing is broken in the meantime.
