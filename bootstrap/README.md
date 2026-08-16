# bootstrap stack: GitHub Actions OIDC

Creates the GitHub Actions OIDC provider and an IAM role that the
`ms3dm-web-infra` repo assumes from CI to run Terraform, with no static access
keys. Managed separately from the workload stacks because CI cannot create the
role it runs as (chicken and egg): apply this once, by hand, with your SSO admin.

## What it creates

- An IAM OIDC identity provider for `token.actions.githubusercontent.com`.
- An IAM role (`github-actions-ms3dm-web-infra`) whose trust policy allows only
  this repo, and only pushes to `main` and pull requests, to assume it.
- Permissions: `PowerUserAccess` (everything except IAM and Organizations) plus
  a narrow IAM policy scoped to the `ms3dm-contact*` role name prefix, so CI can
  manage the contact stack's Lambda role but nothing else.

The account id is never committed: it is resolved at apply time and appears only
in the role ARN output and in remote state.

## Apply (once, locally)

```bash
export AWS_PROFILE=ms3dm-web
aws sso login --profile ms3dm-web    # if the token has expired
cd bootstrap
terraform init
terraform apply
terraform output role_arn
```

## Wire up GitHub

In the `ms3dm-web-infra` repo settings, set:

- Secret `AWS_ROLE_ARN` = the `role_arn` output above.
- Variable `CONTACT_EMAIL` = the contact From/To address (kept out of the repo).

After that, `.github/workflows/terraform.yml` runs `plan` on pull requests and
`apply` on pushes to `main`, assuming the role over OIDC.

## Notes

- The contact From/To address is public (it is shown on the website), but it is
  passed as a repo variable rather than committed. It will appear in CI plan
  logs, which is equivalent to it appearing on the site.
- To tighten later: replace `PowerUserAccess` with a policy scoped to only the
  services the stack uses (Lambda, SES, CloudWatch Logs, S3 state, DynamoDB
  lock).
