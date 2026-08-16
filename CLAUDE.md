# ms3dm-web-infra

Terraform infrastructure-as-code for the **ms3dm-web** AWS account, a public web
workload account. This repo maps one-to-one to a single AWS account: one repo,
one account. The repo's deploy credentials therefore target only that account,
which keeps IAM least-privilege and the blast radius small.

---

## THIS IS A PUBLIC REPO

The number one rule: **never commit secrets or account-specific identifiers.**
Assume every commit is world-readable and permanent (git history and forks
outlive any later deletion).

The following must **never** be committed. They belong only in gitignored files,
remote Terraform state, SSO config, or AWS SSM / Secrets Manager:

- Terraform state (`*.tfstate`, `*.tfstate.*`) and plan files.
- `*.tfvars` with real values. Commit only `*.tfvars.example` placeholders.
- AWS account IDs, and any ARN that embeds an account ID.
- Owner / root emails.
- SES verified addresses.
- Lambda Function URLs and any other endpoint URLs.
- Access keys, secret keys, session tokens, private keys (`*.pem`, `*.key`).
- Any value sourced from Secrets Manager or an SSM SecureString. Reference these
  by **name** at apply time via `data` sources, never inline the resolved value.

If a value identifies the account or could authenticate against it, it does not
go in git.

---

## How auth and config ARE handled instead

### Authentication: IAM Identity Center (SSO)

- Authenticate via AWS IAM Identity Center SSO. Configure an `AWS_PROFILE` for
  the ms3dm-web account and run `aws sso login` before applying.
- Never commit credentials. Never hardcode a profile (or credentials) in the
  provider block. The profile is supplied by the environment (`AWS_PROFILE`),
  not by the code.

### Environment-specific values: Terraform variables

- Real values live in a **LOCAL, gitignored** `*.auto.tfvars` file, or in SSM /
  Secrets Manager read at apply time via `data` sources.
- Only a `*.tfvars.example` with placeholders is committed, so contributors know
  which variables to set without seeing real values.

### Remote state: S3 + DynamoDB lock

- State lives in an **encrypted S3 bucket** with a **DynamoDB lock table**.
- Backend config references non-secret bucket and table names only. Bucket and
  table names are not secrets, but they are also not account identifiers, so
  they are safe to commit.

---

## Conventions

- Run `terraform fmt` and `terraform validate` before every commit.
- Follow least-privilege IAM and the AWS Well-Architected Framework.
- Do **not** use em dashes in AWS resource names or descriptions. Use hyphens.
- The aws provider `region` comes from a **variable**, not a hardcoded literal.
- **Commit `.terraform.lock.hcl`** for reproducible provider versions. It is
  intentionally not gitignored.

---

## Secret-scan safety net (recommended)

Add a secret-scanning guard as a backstop against accidental leaks. Any of:

- **gitleaks** (`gitleaks protect --staged` / `gitleaks detect`), or
- **git-secrets** (`git secrets --scan`), or
- a **pre-commit** hook wrapping one of the above.

This is the last line of defense before a secret reaches a public remote. It
complements, but does not replace, the discipline of never staging secrets in
the first place.
