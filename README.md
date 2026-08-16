# ms3dm-web-infra

Terraform infrastructure-as-code for the ms3dm-web AWS account (public web
workload). See CLAUDE.md for the repo policy (public repo, zero secrets).

## Stacks
- `contact/` : contact-form mailer (Lambda Function URL + Amazon SES).

## Prerequisites
- An AWS IAM Identity Center SSO profile for the ms3dm-web account.
- Remote state bucket and lock table (see BOOTSTRAP.md).

## Deploy the contact stack
```
aws sso login --profile ms3dm-web
export AWS_PROFILE=ms3dm-web
cd contact
cp terraform.tfvars.example terraform.auto.tfvars   # fill in (gitignored)
terraform init
terraform apply
```
Then verify the SES identity (click the email) and read the endpoint:
```
terraform output function_url
```
Set that value as `REACT_APP_CONTACT_ENDPOINT` in the ms3dm website (`public/env.js`).
