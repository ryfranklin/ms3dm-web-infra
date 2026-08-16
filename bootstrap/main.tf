data "aws_caller_identity" "current" {}

# GitHub Actions OIDC issuer certificate, used for the provider thumbprint.
data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com/.well-known/openid-configuration"
}

# One OIDC provider per account for GitHub Actions.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.github.certificates[0].sha1_fingerprint]
  tags            = var.tags
}

locals {
  # Only these GitHub refs may assume the role: pushes to main and pull requests
  # from within the repo. Account id is not committed; it is resolved at apply.
  allowed_subjects = [
    "repo:${var.github_owner}/${var.github_repo}:ref:refs/heads/main",
    "repo:${var.github_owner}/${var.github_repo}:pull_request",
  ]
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.allowed_subjects
    }
  }
}

resource "aws_iam_role" "ci" {
  name                 = var.role_name
  description          = "GitHub Actions OIDC role for ms3dm-web-infra Terraform (plan and apply)."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
  tags                 = var.tags
}

# Broad service access for Terraform minus IAM and Organizations (PowerUserAccess).
# The account is single purpose and further bounded by the Workloads OU SCP, which
# denies the data lake and ML services.
resource "aws_iam_role_policy_attachment" "poweruser" {
  role       = aws_iam_role.ci.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# Add back the narrow IAM needed to manage the stack roles (which PowerUserAccess
# excludes), scoped to the ms3dm-contact* role name prefix.
data "aws_iam_policy_document" "iam_scoped" {
  statement {
    sid = "ManageStackRoles"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:UpdateAssumeRolePolicy",
    ]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/ms3dm-contact*"]
  }

  statement {
    sid       = "PassStackRolesToLambda"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/ms3dm-contact*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "iam_scoped" {
  name   = "${var.role_name}-iam"
  role   = aws_iam_role.ci.id
  policy = data.aws_iam_policy_document.iam_scoped.json
}
