data "aws_caller_identity" "current" {}

locals {
  function_name = "${var.name_prefix}-mailer"

  # Distinct set of addresses to verify as SES identities.
  ses_addresses = toset(distinct([var.from_address, var.to_address]))

  # ARNs of the SES identities used as the sending identity for IAM scoping.
  # The identity region matches the provider region (var.aws_region).
  ses_identity_arns = [
    for addr in local.ses_addresses :
    "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/${addr}"
  ]
}

# SES email identities (verification is a one-time click in the email SES sends).
resource "aws_sesv2_email_identity" "this" {
  for_each       = var.create_ses_identities ? local.ses_addresses : toset([])
  email_identity = each.value
  tags           = var.tags
}

# Package the handler. The AWS SDK v3 ships with the Node.js 20 runtime, so only
# the source file is zipped.
data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/lambda/index.mjs"
  output_path = "${path.module}/build/lambda.zip"
}

# CloudWatch log group, created ahead of the function so retention is enforced.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# Execution role.
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

# Least privilege: write only to this function's log group, send only from the
# verified identities.
data "aws_iam_policy_document" "lambda" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }

  statement {
    sid       = "SendEmail"
    actions   = ["ses:SendEmail"]
    resources = local.ses_identity_arns
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${local.function_name}-policy"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_lambda_function" "mailer" {
  function_name    = local.function_name
  description      = "Sends ms3dm.tech contact-form messages via SES."
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = var.lambda_timeout
  memory_size      = var.lambda_memory

  environment {
    variables = {
      FROM_ADDRESS    = var.from_address
      TO_ADDRESS      = var.to_address
      ALLOWED_ORIGINS = join(",", var.allowed_origins)
    }
  }

  depends_on = [
    aws_iam_role_policy.lambda,
    aws_cloudwatch_log_group.lambda,
  ]

  tags = var.tags
}

# Public Function URL for the static site to POST to. CORS is locked to the
# configured site origins.
resource "aws_lambda_function_url" "mailer" {
  function_name      = aws_lambda_function.mailer.function_name
  authorization_type = "NONE"

  cors {
    allow_origins = var.allowed_origins
    allow_methods = ["POST"]
    allow_headers = ["content-type"]
    max_age       = 3600
  }
}

# Allow public (unauthenticated) invocation of the Function URL only.
resource "aws_lambda_permission" "function_url" {
  statement_id           = "AllowPublicFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.mailer.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}
