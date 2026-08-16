data "aws_caller_identity" "current" {}

# One OIDC provider per account for GitHub Actions. AWS validates the JWKS TLS
# against its trusted CA store for this issuer, so the thumbprints below are
# GitHub's published CA thumbprints (a fixed value, not the rotating leaf cert
# that a TLS lookup would return).
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
  tags = var.tags
}

locals {
  # Scoped to this repo only (any ref/PR/tag within it). This org issues OIDC
  # subjects that embed the immutable GitHub numeric IDs
  # (repo:owner@ownerId/repo@repoId:...), so match both that form and the plain
  # form. Still repo-scoped: no other GitHub repo can assume the role. Account id
  # is not committed; it is resolved at apply.
  allowed_subjects = [
    "repo:${var.github_owner}/${var.github_repo}:*",
    "repo:${var.github_owner}@*/${var.github_repo}@*:*",
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
